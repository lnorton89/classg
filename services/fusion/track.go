// Package fusion correlates per-sensor Detections into Tracks.
//
// Sensors report observations. Fusion is the only component that decides what
// constitutes an aircraft, how confident we are, and whether two sightings are
// the same thing. See docs/architecture/data-model.md.
package fusion

import (
	"encoding/json"
	"math"
	"sort"
	"sync"
	"time"
)

type TrackState string

const (
	StateTentative TrackState = "TENTATIVE"
	StateConfirmed TrackState = "CONFIRMED"
	StateCoasting  TrackState = "COASTING"
	StateClosed    TrackState = "CLOSED"
)

type Lifecycle struct {
	ConfirmMinDetections int
	ConfirmMinSpan       time.Duration
	CoastAfter           time.Duration
	CloseAfter           time.Duration
	HistoryDepth         int
	HistoryMinMoveM      float64
	HistoryMinInterval   time.Duration
}

func DefaultLifecycle() Lifecycle {
	return Lifecycle{
		ConfirmMinDetections: ConfirmMinDetections,
		ConfirmMinSpan:       ConfirmMinSpan,
		CoastAfter:           CoastAfter,
		CloseAfter:           CloseAfter,
		HistoryDepth:         HistoryDepth,
		HistoryMinMoveM:      HistoryMinMoveM,
		HistoryMinInterval:   HistoryMinInterval,
	}
}

// Lifecycle thresholds. Tuned against T2/T5 in docs/planning/test-plan.md --
// coast must outlast a full channel-hop cycle plus a brief occlusion, or a
// hovering drone splits into multiple tracks.
const (
	ConfirmMinDetections = 2
	ConfirmMinSpan       = 2 * time.Second
	CoastAfter           = 30 * time.Second
	CloseAfter           = 300 * time.Second
)

// How much of a flight the trail remembers.
//
// A track document carries its whole history and is republished on every
// detection, so these two numbers set the size of every track message, every
// websocket frame, and every row rewrite. They are chosen against a measured
// flight rather than picked round.
//
// The measurement (2026-08-21, DJI, 163s of a real flight): detections arrived
// at 3.15/s, the aircraft averaged 3.35 m/s, and consecutive recorded positions
// were a median of 0.42m apart -- with 54% of them less than 0.5m from the
// previous one and a quarter of them not moving at all. At 512 points that
// filled in 2m43s, after which the ring buffer dropped the start of the flight
// while it was still being flown: the trail visibly ate its own tail.
const (
	// Positions closer together than this are the same place as far as a map
	// is concerned. At the zoom an operator actually watches a flight at, 2m is
	// under a pixel, so nothing visible is lost -- while roughly half the
	// points, which were GPS jitter around a slow-moving aircraft, are.
	HistoryMinMoveM = 2.0

	// ...but a stationary aircraft must not vanish from its own history. A
	// hover is a real thing to have recorded, so a point still lands on this
	// interval however little the aircraft moved.
	HistoryMinInterval = 2 * time.Second

	// 4096 points at >=2m apart is >=8km of flight path, which outlasts the
	// battery of anything this system is meant to watch. The cap remains for
	// the case the thresholds cannot bound -- a track that never closes -- and
	// dropping the oldest point is still the right behaviour there.
	HistoryDepth = 4096
)

// Evidence classes that corroborate an identification but must never make one
// on their own, however many times they repeat.
//
// An OUI names whoever built the radio, not what is flying it: the DJI rule in
// sensor-wifi's oui_fingerprints.yaml matches an OUI the IEEE registers to a
// chipset vendor, so class C attributes every device using that silicon to DJI.
// Classes D and H carry weight 0.00 because they are indicators, not detections.
//
// sensor-wifi has stated this invariant since class C existed -- see
// from_fingerprint in classg_wifi/detection.py -- but nothing enforced it. On
// 2026-08-17 a lone DJI-OUI access point on ch149, seen for 14 s and never
// again, confirmed itself as an aircraft and sat beside a real Remote ID track
// for the full CloseAfter window. Count and elapsed time cannot substitute for
// corroboration, because a beacon repeating at 10 Hz clears both in a second.
var corroboratingOnlyClasses = map[string]bool{
	"C": true, // Wi-Fi OUI/SSID fingerprint -- MAC randomisation, OUI reuse
	"D": true, // ADS-B -- suppression only; never reaches a track at all
	"H": true, // GNSS interference -- an indicator, not a drone detection
}

// identified reports whether anything has actually identified this track as an
// aircraft, as opposed to merely being consistent with one.
func (t *Track) identified() bool {
	for class := range t.Evidence {
		if !corroboratingOnlyClasses[class] {
			return true
		}
	}
	return false
}

type Position struct {
	Lat          float64  `json:"lat"`
	Lon          float64  `json:"lon"`
	AltGeodeticM *float64 `json:"alt_geodetic_m,omitempty"`
	HeightAGLM   *float64 `json:"height_agl_m,omitempty"`
	// Set only when fusion derived HeightAGLM from a terrain model. Its
	// presence is the provenance marker for HeightAGLM -- see track.schema.json.
	TerrainElevationM *float64 `json:"terrain_elevation_m,omitempty"`
	// Speed and course come from the detection's kinematics block, folded into
	// the fix they arrived with. track.schema.json declares both on position;
	// until they were carried here, every track position served them as null
	// however fast the aircraft was moving.
	SpeedMPS *float64  `json:"speed_mps,omitempty"`
	TrackDeg *float64  `json:"track_deg,omitempty"`
	At       time.Time `json:"at"`
}

type Evidence struct {
	Class      string    `json:"class"`
	SensorKind string    `json:"sensor_kind"`
	Weight     float64   `json:"weight"`
	Count      int       `json:"count"`
	LastSeen   time.Time `json:"last_seen"`
}

// EvidenceMap is the in-memory evidence index, keyed by class for O(1) update
// on every detection.
type EvidenceMap map[string]*Evidence

// MarshalJSON emits the schema shape. track.schema.json declares `evidence` as
// an array; the naive marshalling of the map published an object keyed by
// class, which the API happened to tolerate (model.DecodeTrack accepts both)
// but any schema-validating consumer did not. Sorted by class so the same
// track serialises identically twice.
func (m EvidenceMap) MarshalJSON() ([]byte, error) {
	classes := make([]string, 0, len(m))
	for class := range m {
		classes = append(classes, class)
	}
	sort.Strings(classes)
	out := make([]*Evidence, 0, len(m))
	for _, class := range classes {
		out = append(out, m[class])
	}
	return json.Marshal(out)
}

// Receiver is one radio's contribution to a track.
//
// A unit carries several receivers covering different parts of the spectrum --
// two Wi-Fi radios on a split channel plan, an SDR, an ADS-B feed. Until this
// existed the track kept only sensor_KIND, so everything a second radio told you
// that the first did not was discarded at the door: which radio heard it, how
// much each contributed, and what each measured.
//
// The RSSI matters most. Track.RSSIdBm is the peak across every receiver, and
// the two Wi-Fi adapters have different antennas and different gain, so that
// peak is whichever radio hears loudest rather than how close the aircraft got.
// Split out per receiver, each number is comparable with itself over time.
//
// This is the observation-provenance half of ADR-0009 stage 2 ("which sensors
// contributed"), arrived at for the local two-radio case rather than the
// networked one. The other half -- a weighted-centroid estimate and its error
// radius -- deliberately does NOT live here: that needs the sensor-site
// registry ADR-0009 stage 1 describes, because fusion still does not know where
// any of its receivers are. Per-receiver RSSI without receiver positions is
// evidence, not a fix, and must not be rendered as one.
type Receiver struct {
	SensorID       string    `json:"sensor_id"`
	SensorKind     string    `json:"sensor_kind"`
	DetectionCount int       `json:"detection_count"`
	RSSIdBm        *float64  `json:"rssi_dbm,omitempty"`
	LastSeen       time.Time `json:"last_seen"`
}

// ReceiverMap is the in-memory index, keyed by sensor id for O(1) update on
// every detection. Same trade as EvidenceMap, and the same marshalling problem.
type ReceiverMap map[string]*Receiver

// MarshalJSON emits the schema shape: an array, sorted by sensor_id so the same
// track serialises identically twice. Go randomises map iteration order, and a
// track whose JSON changed on every publish would defeat every diff and cache
// downstream of here.
func (m ReceiverMap) MarshalJSON() ([]byte, error) {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*Receiver, 0, len(m))
	for _, id := range ids {
		out = append(out, m[id])
	}
	return json.Marshal(out)
}

type Identity struct {
	Serial     string   `json:"serial,omitempty"`
	MACs       []string `json:"macs,omitempty"`
	Vendor     string   `json:"vendor,omitempty"`
	OperatorID string   `json:"operator_id,omitempty"`
	UAType     string   `json:"ua_type,omitempty"`
}

type Track struct {
	SchemaVersion  string     `json:"schema_version"`
	TrackID        string     `json:"track_id"`
	State          TrackState `json:"state"`
	FirstSeen      time.Time  `json:"first_seen"`
	LastSeen       time.Time  `json:"last_seen"`
	DetectionCount int        `json:"detection_count"`

	Identity   Identity    `json:"identity"`
	Confidence float64     `json:"confidence"`
	Evidence   EvidenceMap `json:"evidence"`

	Current  *Position  `json:"current,omitempty"`
	History  []Position `json:"history,omitempty"`
	Operator *Position  `json:"operator,omitempty"`

	// RSSIdBm is the strongest signal any detection on this track reported.
	// track.schema.json has declared this field since the beginning, but
	// nothing ever wrote it -- so every consumer, including the console's
	// tracks table, rendered a dash in a column that could never fill. Peak
	// rather than latest, deliberately: it matches what the detail page
	// already summarises ("peak −46 dBm"), it stays meaningful on a CLOSED
	// track, and it answers the operator's actual question, which is "how
	// close did it get".
	RSSIdBm *float64 `json:"rssi_dbm,omitempty"`

	// Receivers attributes the line above. Empty is omitted, so a detection
	// stream with no sensor_id -- which validate() already rejects -- degrades
	// to exactly the previous wire shape rather than to an empty array.
	Receivers ReceiverMap `json:"receivers,omitempty"`

	ADSBCorrelated bool `json:"adsb_correlated"`
}

// confidence combines evidence classes with noisy-OR:
//
//	1 - prod(1 - w_i)
//
// Chosen for being transparent and tunable rather than strictly correct. Classes A
// and B both arrive from the same radio observing the same aircraft, so they are
// not independent in a Bayesian sense; noisy-OR overstates slightly. Revisit if
// measured calibration against the T7 negative control turns out poor.
func (t *Track) recomputeConfidence() {
	product := 1.0
	for _, e := range t.Evidence {
		product *= (1.0 - e.Weight)
	}
	t.Confidence = math.Round((1.0-product)*1000) / 1000
}

func (t *Track) addEvidence(class, sensorKind string, weight float64, at time.Time) {
	e, ok := t.Evidence[class]
	if !ok {
		e = &Evidence{Class: class, SensorKind: sensorKind, Weight: weight}
		t.Evidence[class] = e
	}
	e.Count++
	e.LastSeen = at
	t.recomputeConfidence()
}

// noteReceiver records which radio heard this detection and what it measured.
//
// Deliberately NOT folded into addEvidence: evidence is keyed by class, so two
// radios reporting the same class collapse into one entry with count++ -- which
// is right for confidence (they are not independent observations of a different
// fact) and wrong for attribution (they are different radios). Keeping them
// separate is what lets confidence stay honest while the track still records
// that two receivers heard it.
func (t *Track) noteReceiver(d Detection) {
	if d.SensorID == "" {
		return
	}
	if t.Receivers == nil {
		t.Receivers = make(ReceiverMap)
	}
	r, ok := t.Receivers[d.SensorID]
	if !ok {
		r = &Receiver{SensorID: d.SensorID, SensorKind: d.SensorKind}
		t.Receivers[d.SensorID] = r
	}
	r.DetectionCount++
	// Guarded like Track.LastSeen: detections arrive out of order, and an older
	// one must not drag this receiver's clock backwards.
	if d.TS.After(r.LastSeen) {
		r.LastSeen = d.TS
	}
	// Copied, not aliased, for the reason given at Track.RSSIdBm.
	if v := d.RF.RSSIdBm; v != nil && (r.RSSIdBm == nil || *v > *r.RSSIdBm) {
		peak := *v
		r.RSSIdBm = &peak
	}
}

func (t *Track) updateState(now time.Time, lifecycle Lifecycle) {
	since := now.Sub(t.LastSeen)
	switch {
	case since > lifecycle.CloseAfter:
		t.State = StateClosed
	case since > lifecycle.CoastAfter:
		if t.State == StateConfirmed {
			t.State = StateCoasting
		}
	case t.State == StateCoasting:
		// Reacquired after occlusion. Same track ID by design -- see test T5.
		t.State = StateConfirmed
	case t.State == StateTentative:
		// A track with only corroborating evidence stays TENTATIVE however long
		// it persists. It is still a track -- it keeps its MAC index so a Basic
		// ID arriving later promotes it in place, history intact.
		if t.identified() &&
			t.DetectionCount >= lifecycle.ConfirmMinDetections &&
			t.LastSeen.Sub(t.FirstSeen) >= lifecycle.ConfirmMinSpan {
			t.State = StateConfirmed
		}
	}
}

// addPosition updates the live position always, and extends the trail only when
// the aircraft has actually gone somewhere.
//
// Current and History answer different questions. Current is "where is it now",
// and is replaced on every detection so the marker tracks the aircraft at full
// rate. History is "where has it been", and a point that repeats the previous
// one to within GPS noise adds nothing to that answer while costing the same
// bytes in every subsequent message. See HistoryMinMoveM for the measurement.
func (t *Track) addPosition(p Position, lc Lifecycle) {
	t.Current = &p

	if len(t.History) > 0 && lc.HistoryMinMoveM > 0 {
		last := t.History[len(t.History)-1]
		moved := horizontalDistanceM(last.Lat, last.Lon, p.Lat, p.Lon)
		// Not p.At.Sub(last.At): detections can arrive out of order, and a
		// negative interval would read as "no time passed" and suppress the
		// point rather than keep it.
		elapsed := p.At.Sub(last.At).Abs()
		if moved < lc.HistoryMinMoveM && elapsed < lc.HistoryMinInterval {
			return
		}
	}

	t.History = append(t.History, p)
	if lc.HistoryDepth > 0 && len(t.History) > lc.HistoryDepth {
		t.History = t.History[len(t.History)-lc.HistoryDepth:]
	}
}

// TrackStore owns all track state.
//
// Deliberately in-memory only. Persisting tracks across a restart would resurrect
// stale aircraft that are no longer flying, which is worse than briefly having no
// tracks -- fusion rebuilds from live detections within seconds. See test T6.
type TrackStore struct {
	mu        sync.RWMutex
	bySerial  map[string]*Track
	byMAC     map[string]*Track
	all       map[string]*Track
	weights   map[string]float64
	newID     func() string
	lifecycle Lifecycle
	terrain   TerrainResolver
}

// TerrainResolver is the part of *Terrain that track building needs.
//
// An interface so the store can be tested without a tile server, and so a unit
// with a local elevation model can supply one instead.
type TerrainResolver interface {
	// HeightAGL must not block. Fusion's ingest loop is single-threaded and
	// shared with every sensor on the bus; a resolver that waits on the network
	// here stalls detection, not just enrichment.
	HeightAGL(lat, lon, altGeodeticM float64) (agl, groundM float64, ok bool)
}

// UseTerrain enables deriving height_agl_m for fixes that report a geodetic
// altitude but no height. Passing nil disables it again.
func (s *TrackStore) UseTerrain(r TerrainResolver) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.terrain = r
}

func NewTrackStore(weights map[string]float64, newID func() string) *TrackStore {
	return NewTrackStoreWithLifecycle(weights, newID, DefaultLifecycle())
}

func NewTrackStoreWithLifecycle(weights map[string]float64, newID func() string, lifecycle Lifecycle) *TrackStore {
	return &TrackStore{
		bySerial:  make(map[string]*Track),
		byMAC:     make(map[string]*Track),
		all:       make(map[string]*Track),
		weights:   weights,
		newID:     newID,
		lifecycle: lifecycle,
	}
}

// flightIsOver reports whether a detection belongs to a later flight rather
// than the one this track is recording.
//
// The line is CloseAfter, which is the same threshold that ends a track
// anyway -- so "picked back up" and "flew again" are separated by exactly the
// gap the operator already tunes through fusion.track_ttl, rather than by a
// second notion of the same thing. Everything shorter stays one track,
// including a reacquisition after occlusion: a drone behind a building for
// twenty seconds is still the flight it was, which is why COASTING exists.
//
// The elapsed gap is checked as well as the state, deliberately. A track only
// becomes CLOSED when Reap next runs, so between the flight ending and the
// timer firing the state still reads CONFIRMED -- and that window is precisely
// when a returning aircraft would have been folded into it. Deciding on the
// gap makes the answer independent of whether the reaper happened to fire.
func (s *TrackStore) flightIsOver(t *Track, seen time.Time) bool {
	if t.State == StateClosed {
		return true
	}
	return seen.Sub(t.LastSeen) > s.lifecycle.CloseAfter
}

// unindex drops a track from the identity indexes without disturbing it.
//
// Left in `all` on purpose, with its LastSeen untouched, so Reap closes it
// through the ordinary path and reports that transition to everything
// watching. Closing it here instead would make the state change invisible:
// Reap only reports what it changes.
func (s *TrackStore) unindex(t *Track) {
	if t.Identity.Serial != "" {
		delete(s.bySerial, t.Identity.Serial)
	}
	for _, m := range t.Identity.MACs {
		delete(s.byMAC, m)
	}
}

// resolve implements the identity precedence in docs/architecture/overview.md:
// serial number beats MAC beats nothing. A track first seen by MAC is promoted to
// serial-keyed when a Basic ID finally arrives -- and KEEPS its history, because
// sensors routinely see a Location message before a Basic ID.
func (s *TrackStore) resolve(serial, mac string) *Track {
	if serial != "" {
		if t, ok := s.bySerial[serial]; ok {
			if mac != "" {
				s.byMAC[mac] = t
			}
			return t
		}
		if mac != "" {
			if t, ok := s.byMAC[mac]; ok && t.Identity.Serial == "" {
				t.Identity.Serial = serial
				s.bySerial[serial] = t
				return t
			}
		}
	}
	if mac != "" {
		if t, ok := s.byMAC[mac]; ok {
			return t
		}
	}
	return nil
}

// Ingest folds a detection into the track it belongs to, creating one if
// needed. Returns nil for a detection that must not become a track.
func (s *TrackStore) Ingest(d Detection, now time.Time) *Track {
	// Manned traffic is not a track. ADS-B carries neither serial nor MAC, so
	// resolve can never match one, and before this guard every message minted a
	// fresh zero-confidence track -- a single aircraft at 1 Hz produced hundreds
	// of them, each published on the bus, stored, and drawn on the map as a
	// contact of interest. Class D belongs in ContactStore; see contact.go.
	if d.DetectionClass == ClassADSB {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Lifecycle time is clamped to our own clock. health.Registry learned this
	// the hard way for heartbeats: a sensor running ahead used to stamp them in
	// the future and stay "fresh" long after it died. Tracks had the identical
	// exposure -- a future-stamped detection made a track that never coasted
	// and never closed, a phantom CONFIRMED drone on the map forever. d.TS is
	// still what positions and evidence display; `seen` is what state
	// transitions and expiry are measured against.
	seen := d.TS
	if seen.After(now) {
		seen = now
	}

	serial := d.Identity.Serial
	mac := d.Identity.MAC

	t := s.resolve(serial, mac)
	// The same aircraft flying again is not the same flight. Without this, a
	// second take-off appended to the track the first one left behind: resolve
	// matches on identity alone, and updateState runs AFTER LastSeen is bumped
	// here, so `since` is ~0, no branch matches, and a CLOSED track quietly
	// accumulated new detections while still labelled CLOSED.
	if t != nil && s.flightIsOver(t, seen) {
		s.unindex(t)
		t = nil
	}
	if t == nil {
		// A new track needs an identity, or the next detection from the same
		// aircraft cannot find it. The same unbounded accumulation Class D used
		// to cause follows from any identity-less detection, whatever emitted
		// it, so refuse here rather than trusting every present and future
		// sensor to never send one.
		if serial == "" && mac == "" {
			return nil
		}
		t = &Track{
			SchemaVersion: "1.0",
			TrackID:       s.newID(),
			State:         StateTentative,
			FirstSeen:     seen,
			Evidence:      make(EvidenceMap),
			Identity:      Identity{Serial: serial, Vendor: d.Identity.VendorHint},
		}
		s.all[t.TrackID] = t
		if serial != "" {
			s.bySerial[serial] = t
		}
	}
	if mac != "" {
		s.byMAC[mac] = t
		if !contains(t.Identity.MACs, mac) {
			t.Identity.MACs = append(t.Identity.MACs, mac)
		}
	}
	if serial != "" && t.Identity.Serial == "" {
		t.Identity.Serial = serial
		s.bySerial[serial] = t
	}
	if d.Identity.OperatorID != "" {
		t.Identity.OperatorID = d.Identity.OperatorID
	}
	if d.Identity.UAType != "" {
		t.Identity.UAType = d.Identity.UAType
	}

	// Guarded like ContactStore's LastSeen: detections can be delivered out of
	// order, and an older one must not drag the track backwards into a
	// premature coast.
	if seen.After(t.LastSeen) {
		t.LastSeen = seen
	}
	t.DetectionCount++
	t.addEvidence(d.DetectionClass, d.SensorKind, s.weights[d.DetectionClass], d.TS)
	t.noteReceiver(d)

	// Copied, not aliased: d is a value here but holding a pointer into it
	// keeps the whole Detection alive, and the next caller's frame is nobody's
	// business to retain.
	if r := d.RF.RSSIdBm; r != nil && (t.RSSIdBm == nil || *r > *t.RSSIdBm) {
		peak := *r
		t.RSSIdBm = &peak
	}

	if d.Position != nil {
		p := Position{
			Lat: d.Position.Lat, Lon: d.Position.Lon,
			AltGeodeticM: d.Position.AltGeodeticM,
			HeightAGLM:   d.Position.HeightAGLM,
			At:           d.TS,
		}
		if d.Kinematics != nil {
			p.SpeedMPS = d.Kinematics.SpeedMPS
			p.TrackDeg = d.Kinematics.TrackDeg
		}
		// Only when the aircraft did not say. A height the aircraft reported is
		// measured against its own take-off point or barometer and is the more
		// authoritative of the two; overwriting it with a terrain subtraction
		// would trade a real measurement for an inference.
		if p.HeightAGLM == nil && p.AltGeodeticM != nil && s.terrain != nil {
			if agl, ground, ok := s.terrain.HeightAGL(p.Lat, p.Lon, *p.AltGeodeticM); ok {
				p.HeightAGLM = &agl
				p.TerrainElevationM = &ground
			}
		}
		t.addPosition(p, s.lifecycle)
	}
	if d.Operator != nil {
		t.Operator = &Position{Lat: d.Operator.Lat, Lon: d.Operator.Lon, At: d.TS}
	}

	t.updateState(now, s.lifecycle)
	return t
}

// Reap advances lifecycle state for tracks that stopped being seen and removes
// closed ones. Must be called on a timer -- state transitions are time-driven,
// not detection-driven.
func (s *TrackStore) Reap(now time.Time) []*Track {
	s.mu.Lock()
	defer s.mu.Unlock()

	var changed []*Track
	for id, t := range s.all {
		prev := t.State
		t.updateState(now, s.lifecycle)
		if t.State != prev {
			changed = append(changed, t)
		}
		if t.State == StateClosed {
			delete(s.all, id)
			if t.Identity.Serial != "" {
				delete(s.bySerial, t.Identity.Serial)
			}
			for _, m := range t.Identity.MACs {
				delete(s.byMAC, m)
			}
		}
	}
	return changed
}

func (s *TrackStore) Active() []*Track {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Track, 0, len(s.all))
	for _, t := range s.all {
		out = append(out, t)
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

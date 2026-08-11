// Package fusion correlates per-sensor Detections into Tracks.
//
// Sensors report observations. Fusion is the only component that decides what
// constitutes an aircraft, how confident we are, and whether two sightings are
// the same thing. See docs/architecture/data-model.md.
package fusion

import (
	"math"
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
}

func DefaultLifecycle() Lifecycle {
	return Lifecycle{
		ConfirmMinDetections: ConfirmMinDetections,
		ConfirmMinSpan:       ConfirmMinSpan,
		CoastAfter:           CoastAfter,
		CloseAfter:           CloseAfter,
		HistoryDepth:         HistoryDepth,
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
	HistoryDepth         = 512
)

type Position struct {
	Lat          float64   `json:"lat"`
	Lon          float64   `json:"lon"`
	AltGeodeticM *float64  `json:"alt_geodetic_m,omitempty"`
	HeightAGLM   *float64  `json:"height_agl_m,omitempty"`
	At           time.Time `json:"at"`
}

type Evidence struct {
	Class      string    `json:"class"`
	SensorKind string    `json:"sensor_kind"`
	Weight     float64   `json:"weight"`
	Count      int       `json:"count"`
	LastSeen   time.Time `json:"last_seen"`
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

	Identity   Identity             `json:"identity"`
	Confidence float64              `json:"confidence"`
	Evidence   map[string]*Evidence `json:"evidence"`

	Current  *Position  `json:"current,omitempty"`
	History  []Position `json:"history,omitempty"`
	Operator *Position  `json:"operator,omitempty"`

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
		if t.DetectionCount >= lifecycle.ConfirmMinDetections &&
			t.LastSeen.Sub(t.FirstSeen) >= lifecycle.ConfirmMinSpan {
			t.State = StateConfirmed
		}
	}
}

func (t *Track) addPosition(p Position, historyDepth int) {
	t.Current = &p
	t.History = append(t.History, p)
	if len(t.History) > historyDepth {
		t.History = t.History[len(t.History)-historyDepth:]
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

	serial := d.Identity.Serial
	mac := d.Identity.MAC

	t := s.resolve(serial, mac)
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
			FirstSeen:     d.TS,
			Evidence:      make(map[string]*Evidence),
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

	t.LastSeen = d.TS
	t.DetectionCount++
	t.addEvidence(d.DetectionClass, d.SensorKind, s.weights[d.DetectionClass], d.TS)

	if d.Position != nil {
		t.addPosition(Position{
			Lat: d.Position.Lat, Lon: d.Position.Lon,
			AltGeodeticM: d.Position.AltGeodeticM,
			HeightAGLM:   d.Position.HeightAGLM,
			At:           d.TS,
		}, s.lifecycle.HistoryDepth)
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

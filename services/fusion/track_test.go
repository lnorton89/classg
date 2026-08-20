package fusion

import (
	"encoding/json"
	"fmt"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"os"
	"strings"
	"testing"
	"time"
)

func newTestStore() *TrackStore {
	n := 0
	return NewTrackStore(DefaultWeights(), func() string {
		n++
		return fmt.Sprintf("track-%d", n)
	})
}

func det(class, serial, mac string, ts time.Time) Detection {
	var d Detection
	d.SchemaVersion = "1.0"
	d.DetectionClass = class
	d.SensorID = "wifi-0"
	d.SensorKind = "wifi"
	d.TS = ts
	d.Identity.Serial = serial
	d.Identity.MAC = mac
	return d
}

func TestConfidenceNoisyOr(t *testing.T) {
	s := newTestStore()
	now := time.Now()

	tr := s.Ingest(det("A", "SER1", "aa:bb:cc:dd:ee:ff", now), now)
	if got, want := tr.Confidence, 0.6; got != want {
		t.Fatalf("A alone: got %v want %v", got, want)
	}

	tr = s.Ingest(det("B", "SER1", "aa:bb:cc:dd:ee:ff", now), now)
	// 1 - (0.4 * 0.5) = 0.8
	if got, want := tr.Confidence, 0.8; got != want {
		t.Fatalf("A+B: got %v want %v", got, want)
	}

	tr = s.Ingest(det("C", "SER1", "aa:bb:cc:dd:ee:ff", now), now)
	// 1 - (0.4 * 0.5 * 0.9) = 0.82
	if got, want := tr.Confidence, 0.82; got != want {
		t.Fatalf("A+B+C: got %v want %v", got, want)
	}
}

// The failure mode this guards: a naive detector treats any DJI-OUI MAC as a
// drone and floods the map with false positives. An OUI hit alone must never
// reach CONFIRMED.
func TestFingerprintAloneStaysLowConfidence(t *testing.T) {
	s := newTestStore()
	now := time.Now()

	var tr *Track
	for i := 0; i < 50; i++ {
		tr = s.Ingest(det("C", "", "60:60:1f:11:22:33", now.Add(time.Duration(i)*time.Second)), now)
	}
	if tr.Confidence > 0.10 {
		t.Fatalf("OUI-only confidence should stay at 0.10, got %v", tr.Confidence)
	}
	// This assertion is the point of the test and was missing while the state
	// machine promoted on count and elapsed time alone. 50 detections over 49 s
	// clear both thresholds many times over.
	if tr.State != StateTentative {
		t.Fatalf("OUI-only track reached %s; must stay TENTATIVE", tr.State)
	}
}

// A corroborating-only track is still a track: it holds its MAC index so the
// Basic ID that arrives once the aircraft starts broadcasting Remote ID adopts
// it in place. Losing that would trade one false positive for a split track.
func TestFingerprintTrackConfirmsOnceIdentified(t *testing.T) {
	s := newTestStore()
	now := time.Now()
	mac := "60:60:1f:11:22:33"

	first := s.Ingest(det("C", "", mac, now), now)
	s.Ingest(det("C", "", mac, now.Add(3*time.Second)), now.Add(3*time.Second))
	if first.State != StateTentative {
		t.Fatalf("fingerprint-only track reached %s before any identification", first.State)
	}

	at := now.Add(4 * time.Second)
	tr := s.Ingest(det("A", "SER7", mac, at), at)

	if tr.TrackID != first.TrackID {
		t.Fatalf("Remote ID minted a second track: %s vs %s", tr.TrackID, first.TrackID)
	}
	if tr.State != StateConfirmed {
		t.Fatalf("identified track should confirm, got %s", tr.State)
	}
}

// The 2026-08-17 flight: a DJI-OUI access point on ch149 and the aircraft's
// Remote ID beacon on ch6 are separate MACs that never share a frame, so they
// are necessarily separate tracks. What must not happen is both presenting as
// confirmed aircraft.
func TestUnidentifiedSidecarDoesNotRankAsAircraft(t *testing.T) {
	s := newTestStore()
	now := time.Now()

	var ap *Track
	for i := 0; i < 8; i++ {
		at := now.Add(time.Duration(i) * 2 * time.Second)
		ap = s.Ingest(det("C", "", "0c:9a:e6:47:3c:89", at), at)
	}

	at := now.Add(20 * time.Second)
	drone := s.Ingest(det("A", "1581F9DEC259E0296040", "8c:1e:d9:fc:bb:cc", at), at)
	at = at.Add(3 * time.Second)
	drone = s.Ingest(det("A", "1581F9DEC259E0296040", "8c:1e:d9:fc:bb:cc", at), at)

	if drone.TrackID == ap.TrackID {
		t.Fatal("distinct MACs must not share a track")
	}
	if drone.State != StateConfirmed {
		t.Fatalf("Remote ID track should be CONFIRMED, got %s", drone.State)
	}
	if ap.State != StateTentative {
		t.Fatalf("unidentified access point reached %s; must stay TENTATIVE", ap.State)
	}
}

// Sensors often see a Location message before a Basic ID. Promoting a MAC-keyed
// track to serial-keyed must not lose what came before.
func TestMACTrackPromotedToSerialKeepsHistory(t *testing.T) {
	s := newTestStore()
	now := time.Now()
	mac := "aa:bb:cc:dd:ee:ff"

	first := s.Ingest(det("A", "", mac, now), now)
	first.addPosition(Position{Lat: 47.0, Lon: 8.0, At: now}, HistoryDepth)

	second := s.Ingest(det("A", "SER9", mac, now.Add(time.Second)), now)

	if first.TrackID != second.TrackID {
		t.Fatalf("promotion created a new track: %s vs %s", first.TrackID, second.TrackID)
	}
	if second.Identity.Serial != "SER9" {
		t.Fatalf("serial not adopted: %q", second.Identity.Serial)
	}
	if len(second.History) != 1 {
		t.Fatalf("history lost during promotion: %d entries", len(second.History))
	}
}

func TestLifecycle(t *testing.T) {
	s := newTestStore()
	start := time.Now()

	tr := s.Ingest(det("A", "SER1", "", start), start)
	if tr.State != StateTentative {
		t.Fatalf("first detection should be TENTATIVE, got %s", tr.State)
	}

	later := start.Add(3 * time.Second)
	tr = s.Ingest(det("A", "SER1", "", later), later)
	if tr.State != StateConfirmed {
		t.Fatalf("should confirm after 2 detections spanning >2s, got %s", tr.State)
	}

	s.Reap(later.Add(CoastAfter + time.Second))
	if tr.State != StateCoasting {
		t.Fatalf("should coast after %v, got %s", CoastAfter, tr.State)
	}

	// T5: reacquisition after occlusion keeps the same track.
	back := later.Add(CoastAfter + 5*time.Second)
	tr = s.Ingest(det("A", "SER1", "", back), back)
	if tr.State != StateConfirmed {
		t.Fatalf("should reconfirm on reacquisition, got %s", tr.State)
	}
	if tr.TrackID != "track-1" {
		t.Fatalf("reacquisition created a new track: %s", tr.TrackID)
	}

	s.Reap(back.Add(CloseAfter + time.Second))
	if len(s.Active()) != 0 {
		t.Fatalf("closed track should be reaped, %d remain", len(s.Active()))
	}
}

func TestZeroPositionRejected(t *testing.T) {
	payload := []byte(`{"schema_version":"1.0","detection_id":"x","ts":"2026-08-10T00:00:00Z",
		"sensor_id":"wifi-0","sensor_kind":"wifi","detection_class":"A",
		"position":{"lat":0,"lon":0}}`)
	d, err := ParseDetection(payload)
	if err != nil {
		t.Fatal(err)
	}
	if d.Position != nil {
		t.Fatal("0,0 position should be rejected as 'no GPS fix'")
	}
}

// The health registry learned this for heartbeats; tracks had the identical
// exposure. A sensor clock running ahead must not produce a track whose
// LastSeen sits in the future, because such a track never coasts, never
// closes, and the API-side StaleTrackCloser cannot close it either -- a
// phantom CONFIRMED drone on the map forever.
func TestFutureStampedDetectionCannotPinATrackOpen(t *testing.T) {
	s := newTestStore()
	now := time.Now()

	tr := s.Ingest(det("A", "SER1", "aa:bb:cc:dd:ee:ff", now.Add(2*time.Hour)), now)
	if tr.LastSeen.After(now) {
		t.Fatalf("LastSeen %v is ahead of the ingest clock %v", tr.LastSeen, now)
	}
	if tr.FirstSeen.After(now) {
		t.Fatalf("FirstSeen %v is ahead of the ingest clock %v", tr.FirstSeen, now)
	}

	// With nothing more arriving, the ordinary lifecycle closes it.
	s.Reap(now.Add(CloseAfter + time.Second))
	if len(s.Active()) != 0 {
		t.Fatal("future-stamped track survived a full CloseAfter of silence")
	}
}

// An out-of-order detection must not drag LastSeen backwards into a premature
// coast -- the same guard ContactStore has always had.
func TestOutOfOrderDetectionDoesNotRegressLastSeen(t *testing.T) {
	s := newTestStore()
	now := time.Now()

	s.Ingest(det("A", "SER1", "", now), now)
	tr := s.Ingest(det("A", "SER1", "", now.Add(-time.Minute)), now)
	if tr.LastSeen.Before(now) {
		t.Fatalf("LastSeen regressed to %v", tr.LastSeen)
	}
}

// track.schema.json declares evidence as an ARRAY. The in-memory map used to
// marshal as an object keyed by class, which only worked because the API's
// decoder tolerates both shapes.
func TestTrackMarshalsEvidenceAsSchemaArray(t *testing.T) {
	s := newTestStore()
	now := time.Now()
	s.Ingest(det("B", "SER1", "", now), now)
	tr := s.Ingest(det("A", "SER1", "", now), now)

	body, err := json.Marshal(tr)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Evidence []Evidence `json:"evidence"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatalf("evidence did not decode as an array: %v\n%s", err, body)
	}
	if len(wire.Evidence) != 2 {
		t.Fatalf("evidence = %+v, want 2 entries", wire.Evidence)
	}
	// Sorted by class, so the same track serialises identically twice.
	if wire.Evidence[0].Class != "A" || wire.Evidence[1].Class != "B" {
		t.Fatalf("evidence order = %s, %s; want A, B", wire.Evidence[0].Class, wire.Evidence[1].Class)
	}
}

// speed_mps and track_deg are defined on the schema's position; a detection
// that reports kinematics must not serve them as null forever.
func TestPositionCarriesKinematics(t *testing.T) {
	d := positioned(t, "1596F3BBBBBBBBBBBBBB",
		`{"lat":51.5,"lon":-0.1,"alt_geodetic_m":120}`)
	d.Kinematics = &struct {
		SpeedMPS         *float64 `json:"speed_mps"`
		TrackDeg         *float64 `json:"track_deg"`
		VerticalSpeedMPS *float64 `json:"vertical_speed_mps"`
	}{SpeedMPS: fptr(14.5), TrackDeg: fptr(271)}

	s := newTestStore()
	tr := s.Ingest(d, time.Now())
	if tr.Current == nil || tr.Current.SpeedMPS == nil || tr.Current.TrackDeg == nil {
		t.Fatalf("kinematics were dropped from the fix: %+v", tr.Current)
	}
	if *tr.Current.SpeedMPS != 14.5 || *tr.Current.TrackDeg != 271 {
		t.Fatalf("speed/track = %v/%v", *tr.Current.SpeedMPS, *tr.Current.TrackDeg)
	}
}

// What fusion PUBLISHES is a track, and until now nothing validated one against
// track.schema.json -- the file this package cites in three comments.
//
// TestTrackMarshalsEvidenceAsSchemaArray checks the field that has actually
// broken, by decoding into []Evidence. That is a check against our own idea of
// the contract: it passes for any array, including one whose members are wrong,
// and says nothing about the other thirteen properties. The API tolerates a
// map here on purpose, so a publisher regression is invisible downstream too.
func TestPublishedTrackSatisfiesTheSchema(t *testing.T) {
	source, err := os.ReadFile("../../schemas/track.schema.json")
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(source)))
	if err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("track.schema.json", doc); err != nil {
		t.Fatalf("add schema: %v", err)
	}
	schema, err := compiler.Compile("track.schema.json")
	if err != nil {
		t.Fatalf("compile schema: %v", err)
	}

	// A track with enough on it to exercise the optional branches: two evidence
	// classes, a position, and a confirmed state.
	s := newTestStore()
	now := time.Now().UTC()
	s.Ingest(det("B", "SER1", "", now), now)
	tr := s.Ingest(det("A", "SER1", "", now), now)

	body, err := json.Marshal(tr)
	if err != nil {
		t.Fatal(err)
	}
	instance, err := jsonschema.UnmarshalJSON(strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("decode published track: %v", err)
	}
	if err := schema.Validate(instance); err != nil {
		t.Fatalf("fusion publishes a track track.schema.json rejects: %v (body: %s)", err, body)
	}

	// additionalProperties:false has to be doing work, or the check above
	// passes for anything.
	var loose map[string]any
	if err := json.Unmarshal(body, &loose); err != nil {
		t.Fatal(err)
	}
	loose["invented_field"] = true
	extra, err := json.Marshal(loose)
	if err != nil {
		t.Fatal(err)
	}
	bad, err := jsonschema.UnmarshalJSON(strings.NewReader(string(extra)))
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(bad); err == nil {
		t.Error("the schema accepted an invented field; this check proves nothing")
	}
}

// One aircraft identifying itself differently in two protocols must not become
// two contacts on the map.
//
// This is not hypothetical, and it is not only a DJI quirk: the project's own
// demo capture broadcasts an ASTM Remote ID serial and a DJI DroneID serial
// that differ, from one MAC, because the two wire formats carry different
// factory identifiers for the same airframe. `scripts/make-demo-capture.py` is
// the first thing a new operator runs, so this is the correlation rule their
// first map depends on -- and the failure mode is two aircraft where there is
// one, which is worse than a miss: it invents traffic.
func TestTwoSerialsFromOneMACStayOneTrack(t *testing.T) {
	s := newTestStore()
	now := time.Now()
	const mac = "60:60:1f:aa:bb:cc"
	const odidSerial = "1596F3B24C5D7E8F9A0B" // ASTM Basic ID
	const djiSerial = "1581F5FMD234A00A"      // DJI DroneID

	// Class A first, which is the order the demo capture produces.
	a := s.Ingest(det("A", odidSerial, mac, now), now)
	b := s.Ingest(det("B", djiSerial, mac, now.Add(200*time.Millisecond)), now.Add(200*time.Millisecond))

	if a.TrackID != b.TrackID {
		t.Fatalf("two serials from one MAC made two tracks: %s and %s", a.TrackID, b.TrackID)
	}
	if got := len(s.Active()); got != 1 {
		t.Fatalf("%d active tracks, want 1", got)
	}
	// The first serial stays: resolve only adopts one onto a track that has
	// none, so a second protocol cannot rename an aircraft mid-flight.
	if b.Identity.Serial != odidSerial {
		t.Errorf("serial is %q, want the first one seen (%q)", b.Identity.Serial, odidSerial)
	}
	// And both classes count as evidence, which is the point of seeing two.
	if _, ok := b.Evidence["A"]; !ok {
		t.Error("class A evidence missing")
	}
	if _, ok := b.Evidence["B"]; !ok {
		t.Error("class B evidence missing")
	}

	// The reverse order must fold too -- a sensor that decodes the DJI IE first
	// is not a different aircraft.
	s2 := newTestStore()
	x := s2.Ingest(det("B", djiSerial, mac, now), now)
	y := s2.Ingest(det("A", odidSerial, mac, now.Add(200*time.Millisecond)), now.Add(200*time.Millisecond))
	if x.TrackID != y.TrackID {
		t.Fatalf("DJI-first ordering made two tracks: %s and %s", x.TrackID, y.TrackID)
	}
	if got := len(s2.Active()); got != 1 {
		t.Fatalf("DJI-first: %d active tracks, want 1", got)
	}
}

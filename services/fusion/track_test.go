package fusion

import (
	"fmt"
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

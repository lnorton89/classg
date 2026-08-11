package fusion

import (
	"testing"
	"time"
)

func adsb(icao, callsign string, altFt *int, ts time.Time) Detection {
	var d Detection
	d.SchemaVersion = "1.0"
	d.DetectionClass = ClassADSB
	d.SensorID = "sdr-0"
	d.SensorKind = "sdr"
	d.TS = ts
	d.ADSB = &struct {
		ICAO     string `json:"icao"`
		Callsign string `json:"callsign"`
		AltFt    *int   `json:"alt_ft"`
	}{ICAO: icao, Callsign: callsign, AltFt: altFt}
	return d
}

func withPosition(d Detection, lat, lon float64) Detection {
	d.Position = &struct {
		Lat          float64  `json:"lat"`
		Lon          float64  `json:"lon"`
		AltGeodeticM *float64 `json:"alt_geodetic_m"`
		HeightAGLM   *float64 `json:"height_agl_m"`
	}{Lat: lat, Lon: lon}
	return d
}

// The regression this whole file exists for. ADS-B carries no serial and no
// MAC, so every message used to fall through resolve and mint a fresh track:
// one aircraft at 1 Hz produced hundreds of zero-confidence tracks, each
// published, stored and drawn on the map.
func TestADSBNeverCreatesTracks(t *testing.T) {
	s := newTestStore()
	start := time.Now()

	for i := 0; i < 20; i++ {
		ts := start.Add(time.Duration(i) * time.Second)
		if tr := s.Ingest(withPosition(adsb("4B1814", "REGA10", nil, ts), 47.1, 8.2), ts); tr != nil {
			t.Fatalf("ADS-B detection produced track %s", tr.TrackID)
		}
	}
	if n := len(s.Active()); n != 0 {
		t.Fatalf("20 ADS-B detections created %d tracks, want 0", n)
	}
}

// The same accumulation follows from any detection that cannot be resolved
// again, not just Class D.
func TestIdentitylessDetectionCreatesNoTrack(t *testing.T) {
	s := newTestStore()
	now := time.Now()

	for i := 0; i < 10; i++ {
		if tr := s.Ingest(det("C", "", "", now.Add(time.Duration(i)*time.Second)), now); tr != nil {
			t.Fatalf("identity-less detection produced track %s", tr.TrackID)
		}
	}
	if n := len(s.Active()); n != 0 {
		t.Fatalf("identity-less detections created %d tracks, want 0", n)
	}
}

// One aircraft is one contact however many messages it sends -- the property
// the track path could not provide.
func TestContactsAreKeyedByICAO(t *testing.T) {
	s := NewContactStore()
	start := time.Now()

	for i := 0; i < 20; i++ {
		ts := start.Add(time.Duration(i) * time.Second)
		if c, _ := s.Observe(withPosition(adsb("4B1814", "REGA10", nil, ts), 47.1, 8.2)); c == nil {
			t.Fatal("valid ADS-B detection was rejected")
		}
	}
	if n := s.Len(); n != 1 {
		t.Fatalf("20 messages from one aircraft made %d contacts, want 1", n)
	}

	c := s.Active()[0]
	if c.Messages != 20 {
		t.Fatalf("message count: got %d want 20", c.Messages)
	}
	if c.Callsign != "REGA10" {
		t.Fatalf("callsign: got %q", c.Callsign)
	}
	if !c.LastSeen.Equal(start.Add(19 * time.Second)) {
		t.Fatalf("last seen: got %v", c.LastSeen)
	}
}

func TestContactICAOCaseIsFolded(t *testing.T) {
	s := NewContactStore()
	now := time.Now()

	s.Observe(adsb("4b1814", "", nil, now))
	s.Observe(adsb("4B1814", "", nil, now.Add(time.Second)))

	if n := s.Len(); n != 1 {
		t.Fatalf("mixed-case ICAO made %d contacts, want 1", n)
	}
	if got := s.Active()[0].ICAO; got != "4B1814" {
		t.Fatalf("ICAO not normalised: %q", got)
	}
}

// An unkeyable detection must not be retained under some placeholder, which
// would reintroduce per-message accumulation by another route.
func TestContactWithoutICAORejected(t *testing.T) {
	s := NewContactStore()
	now := time.Now()

	if c, _ := s.Observe(adsb("", "GHOST", nil, now)); c != nil {
		t.Fatal("ADS-B with no ICAO address should be rejected")
	}
	if c, _ := s.Observe(adsb("   ", "GHOST", nil, now)); c != nil {
		t.Fatal("blank ICAO address should be rejected")
	}

	var noBlock Detection
	noBlock.DetectionClass = ClassADSB
	noBlock.TS = now
	if c, _ := s.Observe(noBlock); c != nil {
		t.Fatal("Class D with no adsb block should be rejected")
	}
	if n := s.Len(); n != 0 {
		t.Fatalf("rejected detections still made %d contacts", n)
	}
}

// Most ADS-B messages carry no position: identity, velocity and altitude
// arrive separately. An identity-only message must not blank the last fix.
func TestIdentityOnlyMessageKeepsLastPosition(t *testing.T) {
	s := NewContactStore()
	now := time.Now()

	s.Observe(withPosition(adsb("ABCDEF", "", nil, now), 47.1, 8.2))
	alt := 2100
	c, _ := s.Observe(adsb("ABCDEF", "SWR123", &alt, now.Add(time.Second)))

	if c.Current == nil {
		t.Fatal("identity-only message cleared the last known position")
	}
	if c.Current.Lat != 47.1 || c.Current.Lon != 8.2 {
		t.Fatalf("position changed: %+v", c.Current)
	}
	if c.AltFt == nil || *c.AltFt != 2100 {
		t.Fatalf("altitude not adopted: %v", c.AltFt)
	}
}

// ADS-B message types interleave and can arrive out of order. An older message
// must not drag LastSeen backwards, which would expire a live aircraft early.
func TestOutOfOrderMessageDoesNotRewindLastSeen(t *testing.T) {
	s := NewContactStore()
	now := time.Now()

	s.Observe(adsb("ABCDEF", "", nil, now))
	c, _ := s.Observe(adsb("ABCDEF", "", nil, now.Add(-10*time.Second)))

	if !c.LastSeen.Equal(now) {
		t.Fatalf("last seen rewound to %v, want %v", c.LastSeen, now)
	}
	if !c.FirstSeen.Equal(now.Add(-10 * time.Second)) {
		t.Fatalf("first seen should widen to the earlier message, got %v", c.FirstSeen)
	}
}

// A contact that outlives its aircraft is worse than no contact: from
// Milestone 2 it suppresses detections it has no business explaining.
func TestQuietContactsExpire(t *testing.T) {
	s := NewContactStore()
	now := time.Now()

	s.Observe(adsb("ABCDEF", "", nil, now))
	s.Observe(adsb("123456", "", nil, now.Add(ContactExpireAfter)))

	expired := s.Reap(now.Add(ContactExpireAfter + time.Second))
	if len(expired) != 1 || expired[0] != "ABCDEF" {
		t.Fatalf("expired the wrong contacts: %v", expired)
	}
	if n := s.Len(); n != 1 {
		t.Fatalf("%d contacts remain, want 1", n)
	}
}

// Suppression reasons about drones and manned traffic together, so the two
// stores are read concurrently. Guards against a regression under -race.
func TestContactStoreConcurrentAccess(t *testing.T) {
	s := NewContactStore()
	now := time.Now()
	done := make(chan struct{})

	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			s.Observe(adsb("ABCDEF", "", nil, now.Add(time.Duration(i)*time.Millisecond)))
		}
	}()
	for i := 0; i < 200; i++ {
		s.Active()
		s.Len()
		s.Reap(now)
	}
	<-done
}

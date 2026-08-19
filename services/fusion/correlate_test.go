package fusion

import (
	"testing"
	"time"
)

// withFix is withPosition plus an altitude, for the tests that exercise the
// altitude gate.
func withFix(d Detection, lat, lon float64, altGeodeticM *float64) Detection {
	d = withPosition(d, lat, lon)
	d.Position.AltGeodeticM = altGeodeticM
	return d
}

func fptr(v float64) *float64 { return &v }
func iptr(v int) *int         { return &v }

// The reason ADSBCorrelated exists at all: a transponder-equipped aircraft
// that fusion also sees as a track must be explained away as manned traffic --
// and released again when the contact leaves, because a stale correlation
// suppresses a real aircraft.
func TestTrackNearContactCorrelatesAndReleases(t *testing.T) {
	s := newTestStore()
	contacts := NewContactStore()
	now := time.Now()

	// ~914 m geodetic vs 3000 ft (914.4 m) pressure: inside the altitude gate.
	tr := s.Ingest(withFix(det("A", "SER1", "aa:bb:cc:dd:ee:ff", now), 51.5000, -0.1000, fptr(914.0)), now)

	contact, _ := contacts.Observe(withPosition(adsb("ABC123", "SPEED1", iptr(3000), now), 51.5005, -0.1000))
	if contact == nil {
		t.Fatal("contact was not created")
	}

	changed := s.CorrelateContacts(contacts.Active())
	if len(changed) != 1 || changed[0].TrackID != tr.TrackID {
		t.Fatalf("changed = %v, want the one track", changed)
	}
	if !tr.ADSBCorrelated {
		t.Fatal("a track 55 m from a contemporaneous contact fix did not correlate")
	}

	// Second pass, same state: no change, so nothing republished.
	if changed := s.CorrelateContacts(contacts.Active()); len(changed) != 0 {
		t.Fatalf("an unchanged flag was reported as changed: %v", changed)
	}

	// The contact expires. The flag must clear on the next pass -- latching it
	// would let an airliner that left minutes ago keep suppressing this track.
	contacts.Reap(now.Add(2 * ContactExpireAfter))
	changed = s.CorrelateContacts(contacts.Active())
	if len(changed) != 1 || tr.ADSBCorrelated {
		t.Fatalf("flag did not release after the contact expired: changed=%v correlated=%v",
			changed, tr.ADSBCorrelated)
	}
}

// Every gate vetoes on its own. A false correlation silences the alert for a
// real drone, so each of these MUST refuse.
func TestCorrelationGatesAreConservative(t *testing.T) {
	now := time.Now()

	cases := []struct {
		name    string
		track   Detection
		contact Detection
	}{
		{
			name:    "horizontal distance",
			track:   withPosition(det("A", "S1", "aa:bb:cc:dd:ee:01", now), 51.5000, -0.1000),
			contact: withPosition(adsb("AAA001", "", nil, now), 51.5400, -0.1000), // ~4.4 km north
		},
		{
			name:    "altitude disagreement",
			track:   withFix(det("A", "S2", "aa:bb:cc:dd:ee:02", now), 51.5000, -0.1000, fptr(60)),
			contact: withPosition(adsb("AAA002", "", iptr(3000), now), 51.5000, -0.1000), // 914 m up
		},
		{
			name:    "fix time skew",
			track:   withPosition(det("A", "S3", "aa:bb:cc:dd:ee:03", now), 51.5000, -0.1000),
			contact: withPosition(adsb("AAA003", "", nil, now.Add(-time.Minute)), 51.5000, -0.1000),
		},
		{
			name:    "track with no position",
			track:   det("A", "S4", "aa:bb:cc:dd:ee:04", now),
			contact: withPosition(adsb("AAA004", "", nil, now), 51.5000, -0.1000),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newTestStore()
			contacts := NewContactStore()
			tr := s.Ingest(c.track, now)
			if contact, _ := contacts.Observe(c.contact); contact == nil {
				t.Fatal("contact was not created")
			}
			if changed := s.CorrelateContacts(contacts.Active()); len(changed) != 0 {
				t.Fatalf("gate did not veto; changed = %v", changed)
			}
			if tr.ADSBCorrelated {
				t.Fatal("track correlated through a gate that should have vetoed")
			}
		})
	}
}

// A contact with a fresh identity message but a stale position fix must not
// correlate on the old fix: Observe keeps the last known position, and only
// the fix's own timestamp says how old it is.
func TestCorrelationUsesTheFixTimeNotTheContactTime(t *testing.T) {
	s := newTestStore()
	contacts := NewContactStore()
	now := time.Now()

	// Position fix from a minute ago...
	contacts.Observe(withPosition(adsb("BBB001", "", nil, now.Add(-time.Minute)), 51.5000, -0.1000))
	// ...then an identity-only message just now, which bumps LastSeen but not
	// the fix.
	contacts.Observe(adsb("BBB001", "", nil, now))

	tr := s.Ingest(withPosition(det("A", "S5", "aa:bb:cc:dd:ee:05", now), 51.5000, -0.1000), now)
	s.CorrelateContacts(contacts.Active())
	if tr.ADSBCorrelated {
		t.Fatal("correlated against a position fix older than the skew gate")
	}
}

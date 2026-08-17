package health

import (
	"testing"
	"time"
)

// The dangerous direction. A sensor whose clock runs ahead stamps heartbeats in
// the future, so subtracting its clock from ours produced a negative age that
// could never exceed staleAfter -- a sensor that had gone silent kept reporting
// healthy indefinitely. That is exactly the false confidence this package
// exists to prevent, reached through the clock rather than through the radio.
func TestSensorWithAClockAheadStillGoesStale(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Heartbeat(Heartbeat{
		SensorID:   "wifi-0",
		SensorKind: "wifi",
		Healthy:    true,
		TS:         now.Add(8 * time.Hour), // the sensor believes it is 8h later
		At:         now,                    // we heard it at `now`
	})

	// Ten minutes of silence by our clock; still "in the future" by the sensor's.
	rep := r.Snapshot(now.Add(10*time.Minute), time.Minute, "test", nil)

	s := rep.Sensors[0]
	if s.Healthy {
		t.Fatal("a sensor silent for 10 minutes must be stale whatever its own clock says")
	}
	if s.Reason != "heartbeat stale" {
		t.Fatalf("reason = %q, want %q", s.Reason, "heartbeat stale")
	}
	if got := *s.SecondsSinceHeartbeat; got != 600 {
		t.Fatalf("seconds_since_heartbeat = %d, want 600 measured on our clock", got)
	}
	// The sensor's own claim is still reported verbatim, so the skew stays
	// visible to whoever is reading the payload.
	if !s.LastHeartbeat.Equal(now.Add(8 * time.Hour)) {
		t.Fatalf("last_heartbeat = %v, want the sensor's reported time", s.LastHeartbeat)
	}
}

// The other direction, and the one that actually happens on this hardware. A Pi
// with no RTC boots on fake-hwclock's saved timestamp, the Wi-Fi sensor
// heartbeats with that clock, and timesyncd then jumps the api forward hours.
// Measuring age from the sensor's stamp declared every sensor stale at once, so
// a working detector reported itself down.
func TestSensorWithAClockBehindIsNotFalselyStale(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Heartbeat(Heartbeat{
		SensorID:   "wifi-0",
		SensorKind: "wifi",
		Healthy:    true,
		TS:         now.Add(-8 * time.Hour), // pre-NTP clock on the sensor
		At:         now,
	})

	rep := r.Snapshot(now.Add(time.Second), time.Minute, "test", nil)

	s := rep.Sensors[0]
	if !s.Healthy {
		t.Fatalf("a sensor heard from a second ago must be healthy, got reason %q", s.Reason)
	}
	if got := *s.SecondsSinceHeartbeat; got != 1 {
		t.Fatalf("seconds_since_heartbeat = %d, want 1", got)
	}
}

// Heartbeats that predate the At field -- and every existing caller in the
// tests -- must keep behaving exactly as they did.
func TestHeartbeatWithoutAnObservedTimeFallsBackToItsTimestamp(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Heartbeat(Heartbeat{
		SensorID: "wifi-0", SensorKind: "wifi", Healthy: true,
		TS: now.Add(-2 * time.Second),
	})

	rep := r.Snapshot(now, time.Minute, "test", nil)

	s := rep.Sensors[0]
	if !s.Healthy {
		t.Fatalf("want healthy, got reason %q", s.Reason)
	}
	if got := *s.SecondsSinceHeartbeat; got != 2 {
		t.Fatalf("seconds_since_heartbeat = %d, want 2", got)
	}
}

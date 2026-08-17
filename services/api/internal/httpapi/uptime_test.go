package httpapi_test

import (
	"context"
	"testing"
	"time"
)

// A freshly started api reports roughly no uptime. Weak on its own, but it is
// the end of the path the test below pins the mechanism for.
func TestFreshServerReportsNearZeroUptime(t *testing.T) {
	h := newHarness(t, nil)

	rep := h.server.Health(context.Background())
	if rep.UptimeS < 0 || rep.UptimeS > 5 {
		t.Fatalf("uptime_s = %d, want ~0 for a server started moments ago", rep.UptimeS)
	}
}

// Pins the distinction the uptime fix rests on.
//
// Go attaches a monotonic reading to time.Now() and uses it for Sub only when
// both operands still carry one; .UTC() strips it. Health used to subtract a
// UTC-converted now from the start time, so it was doing wall-clock arithmetic
// and reported every correction to the system clock as uptime. On the unit that
// meant /health claiming 9h55m for a process 2h04m old, inflated by exactly the
// 7h51m jump systemd-timesyncd applies when an RTC-less Pi first reaches a time
// server.
//
// A test cannot move the host's system clock, so the correction is modelled
// rather than performed: `jumped` stands in for the wall clock after timesyncd
// lands, and the two formulations are compared against the same start.
func TestMonotonicElapsedIgnoresAWallClockCorrection(t *testing.T) {
	const correction = 7*time.Hour + 51*time.Minute

	started := time.Now()
	jumped := time.Now().UTC().Add(correction)

	if wall := jumped.Sub(started); wall < correction {
		t.Fatalf("wall-clock subtraction should absorb the correction, got %s", wall)
	}
	if mono := time.Since(started); mono > time.Minute {
		t.Fatalf("monotonic elapsed should ignore the correction, got %s", mono)
	}
}

package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/classg/api/internal/health"
)

// detectionWindow is the contract's detections_5m.
const detectionWindow = 5 * time.Minute

// Health builds the report. Exported because the stream publisher pushes the
// same object on the health topic, and the two must never disagree.
func (s *Server) Health(ctx context.Context) health.Report {
	// Not .UTC() here: Snapshot measures sensor ages against this, and the
	// conversion would strip the monotonic reading those subtractions rely on.
	now := time.Now()
	counts, err := s.store.DetectionCountsSince(ctx, now.UTC().Add(-detectionWindow))
	if err != nil {
		// A storage failure must not turn into a 500 on the one endpoint an
		// operator reaches for when things are broken. Zero counts alongside
		// real heartbeat state still answers the question that matters.
		counts = map[string]int{}
	}
	// time.Since, not now.Sub(s.started): Go carries a monotonic reading on the
	// result of time.Now() and uses it for subtraction only when BOTH operands
	// still have one. `now` above has been through .UTC(), which strips it, so
	// now.Sub(s.started) silently degraded to wall-clock arithmetic and reported
	// every correction to the system clock as uptime.
	//
	// That is not hypothetical on this hardware. A Pi has no RTC: it boots with
	// whatever fake-hwclock saved, the api starts, and systemd-timesyncd jumps
	// the clock forward when the network appears. Measured on the unit on
	// 2026-08-17 -- /health claimed uptime_s 35727 (9h55m) for a process that
	// had been running 2h04m, inflated by exactly the 7h51m NTP correction.
	return s.registry.Snapshot(now, time.Since(s.started), s.cfg.Version, counts)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	rep := s.Health(r.Context())
	// Always 200. The status field carries the verdict; making an unhealthy
	// detector also return 5xx would mean load balancers and probes hide the
	// very diagnosis the caller asked for. classgctl maps status to its exit
	// code instead.
	writeJSON(w, http.StatusOK, rep)
}

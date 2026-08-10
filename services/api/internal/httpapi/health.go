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
	now := time.Now().UTC()
	counts, err := s.store.DetectionCountsSince(ctx, now.Add(-detectionWindow))
	if err != nil {
		// A storage failure must not turn into a 500 on the one endpoint an
		// operator reaches for when things are broken. Zero counts alongside
		// real heartbeat state still answers the question that matters.
		counts = map[string]int{}
	}
	return s.registry.Snapshot(now, now.Sub(s.started), s.cfg.Version, counts)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	rep := s.Health(r.Context())
	// Always 200. The status field carries the verdict; making an unhealthy
	// detector also return 5xx would mean load balancers and probes hide the
	// very diagnosis the caller asked for. classgctl maps status to its exit
	// code instead.
	writeJSON(w, http.StatusOK, rep)
}

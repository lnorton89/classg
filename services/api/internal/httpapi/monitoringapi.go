package httpapi

import (
	"net/http"
	"time"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/settings"
)

// SettingMonitoringEnabled persists the switch across restarts. Without it a
// deliberate pause would silently undo itself on the next restart -- and a
// detector that resumes recording without being asked is as wrong as one that
// stops without being asked.
const SettingMonitoringEnabled = "monitoring.enabled"

type monitoringRequest struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
}

func (s *Server) handleGetMonitoring(w http.ResponseWriter, r *http.Request) {
	if s.monitoring == nil {
		fail(w, apierr.Internal("monitoring state is not available"))
		return
	}
	writeJSON(w, http.StatusOK, s.monitoring.State())
}

// handlePutMonitoring starts or pauses recording.
//
// This does NOT stop the radio. The sensor is a separate process under its own
// supervisor, often on another machine, so the API cannot reliably signal it.
// Gating ingestion is the mechanism that works everywhere, and it makes
// resuming instant instead of waiting for a radio to re-acquire.
func (s *Server) handlePutMonitoring(w http.ResponseWriter, r *http.Request) {
	if s.monitoring == nil {
		fail(w, apierr.Internal("monitoring state is not available"))
		return
	}
	var req monitoringRequest
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}
	if len(req.Reason) > 200 {
		fail(w, apierr.InvalidParameter("reason", "reason must be 200 characters or fewer"))
		return
	}

	state := s.monitoring.Set(req.Enabled, req.Reason, time.Now().UTC())

	// Persist through the settings tier so the choice survives a restart. A
	// failure here is logged but not fatal: the running state is already
	// correct, and refusing the request would be worse than a pause that does
	// not outlive the process.
	value := "false"
	if req.Enabled {
		value = "true"
	}
	if err := settings.PutOne(r.Context(), s.store, SettingMonitoringEnabled, value); err != nil {
		writeJSON(w, http.StatusOK, struct {
			State   any    `json:"state"`
			Warning string `json:"warning"`
		}{state, "recording state changed but could not be saved; it will reset on restart"})
		return
	}
	writeJSON(w, http.StatusOK, state)
}

package httpapi

import (
	"net/http"
	"time"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/settings"
)

// SettingMonitoringEnabled records the live state of the switch. It is written
// on every change and at startup, but deliberately NOT read back to decide
// whether to record: if the stack is up, it is recording. A pause lasts as long
// as the process does.
//
// The rejected alternative was persisting a pause across restarts. It sounds
// more respectful of the operator's choice, but it means a stack can come up
// and sit there not recording, looking healthy, because of something somebody
// clicked a week ago. Restarting to resume is a cost worth paying to make that
// state unreachable.
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

	// Persist through the settings tier so anything reading configuration sees
	// the live state. A failure here is not fatal: the running state is already
	// correct, and startup does not consult the stored value anyway.
	value := "false"
	if req.Enabled {
		value = "true"
	}
	if err := settings.PutOne(r.Context(), s.store, SettingMonitoringEnabled, value); err != nil {
		writeJSON(w, http.StatusOK, struct {
			State   any    `json:"state"`
			Warning string `json:"warning"`
		}{state, "recording state changed but could not be saved; the change is in effect, and stored configuration now reports the wrong value"})
		return
	}
	writeJSON(w, http.StatusOK, state)
}

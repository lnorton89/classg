package httpapi

// What this unit is running, and a way to ask for an update.
//
// The API cannot deploy anything. It reads a file the host-side script writes
// and writes a file the script reads -- see internal/deploy for why a
// containerised, web-facing process is deliberately given no host control.

import (
	"net/http"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/deploy"
)

func (s *Server) handleDeploymentStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.deploy.Status())
}

// handleDeploymentHistory lists past runs, newest first.
//
// Admin like the rest of this surface: the log can name branches, commit
// subjects and failure reasons, which describe the operator's infrastructure
// rather than the airspace.
func (s *Server) handleDeploymentHistory(w http.ResponseWriter, r *http.Request) {
	limit, err := intParam(r, "limit", deploy.DefaultHistoryLimit, deploy.HistoryMax)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.deploy.History(limit))
}

type deployRequestResponse struct {
	Requested bool `json:"requested"`
	// Note says what "requested" actually means, because it does not mean
	// "deploying now" and an operator watching a spinner deserves to know that.
	Note string `json:"note"`
	deploy.Status
}

// handleRequestDeploy raises a hand for the next tick.
func (s *Server) handleRequestDeploy(w http.ResponseWriter, r *http.Request) {
	if !s.deploy.Enabled() {
		fail(w, apierr.Conflict("this unit has no deploy agent configured"))
		return
	}

	by := "unknown"
	if p, ok := PrincipalFrom(r.Context()); ok {
		by = p.User.Username
		if p.Anonymous {
			by = "unauthenticated (auth disabled)"
		}
	}

	if err := s.deploy.Request(by); err != nil {
		fail(w, apierr.Internal("could not record the deploy request: "+err.Error()))
		return
	}
	writeJSON(w, http.StatusAccepted, deployRequestResponse{
		Requested: true,
		Note: "Queued. The deploy agent picks this up on its next check, " +
			"which is within ten minutes. It still refuses if CI is not green, " +
			"or if a capture or sweep is running.",
		Status: s.deploy.Status(),
	})
}

// handleWatchdogStatus reports what the self-repair agent has been doing.
func (s *Server) handleWatchdogStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.deploy.Watchdog())
}

func (s *Server) handleCancelDeploy(w http.ResponseWriter, r *http.Request) {
	if !s.deploy.Enabled() {
		fail(w, apierr.Conflict("this unit has no deploy agent configured"))
		return
	}
	if err := s.deploy.Cancel(); err != nil {
		fail(w, apierr.Internal("could not withdraw the deploy request: "+err.Error()))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

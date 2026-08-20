package httpapi

import (
	"net/http"
	"sort"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/settings"
)

// settingsResponse is the whole Tier 2 set with each value's provenance.
//
// Reporting `source` is the entire point of ADR-0007. The bug it was written
// against was three files disagreeing about the default store with no way to
// tell which won; a settings endpoint that returned only values would recreate
// exactly that.
type settingsResponse struct {
	Settings map[string]settings.Value `json:"settings"`
	// EnvOverridden lists keys the environment is holding, so a UI can explain
	// why a field is read-only rather than appearing broken.
	EnvOverridden []string `json:"env_overridden"`
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if s.settings == nil {
		fail(w, apierr.Internal("settings are not available"))
		return
	}
	all := s.settings.All()
	var overridden []string
	for k, v := range all {
		if v.Source == settings.SourceEnv {
			overridden = append(overridden, k)
		}
	}
	sort.Strings(overridden)
	writeJSON(w, http.StatusOK, settingsResponse{Settings: all, EnvOverridden: overridden})
}

// handlePutSettings applies a partial update: {"retention.tracks": "720h"}.
//
// Values are strings regardless of the setting's type. One parser for every
// tier means a duration written into the seed file, the database, or the
// environment is validated identically -- which is what stops the tiers drifting
// apart again.
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	if s.settings == nil {
		fail(w, apierr.Internal("settings are not available"))
		return
	}
	var updates map[string]string
	if err := decodeBody(r, &updates); err != nil {
		fail(w, err)
		return
	}
	if len(updates) == 0 {
		fail(w, apierr.InvalidParameter("body", "provide at least one setting to change"))
		return
	}

	keys := make([]string, 0, len(updates))
	for k := range updates {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic error for a body with several problems

	current := s.settings.All()
	for _, k := range keys {
		// Immutability first: it is the more fundamental refusal. A key read
		// once at startup cannot be changed at runtime whether or not the
		// environment also happens to be holding it, and saying so is clearer
		// than blaming an env var the operator could unset to no effect.
		if err := settings.ValidateOne(k, updates[k]); err != nil {
			fail(w, apierr.InvalidParameter(k, err.Error()))
			return
		}
		// Then reject an environment-held key rather than writing a stored
		// value the process will keep ignoring. Silently accepting it is the
		// worst outcome: the operator sees a success, restarts, nothing changed.
		if v, ok := current[k]; ok && v.Source == settings.SourceEnv {
			fail(w, apierr.Conflict(
				k+" is currently set in the environment, which takes precedence over stored "+
					"settings. Unset it to manage this value here."))
			return
		}
	}

	if err := settings.PutMany(r.Context(), s.store, updates); err != nil {
		fail(w, apierr.Internal("saving settings failed"))
		return
	}
	// Re-resolve, or the value this endpoint reports stays at whatever startup
	// assembled and the next GET tells the operator their save did not happen.
	// The store already has it either way; this is about not lying about that.
	if err := s.settings.Update(updates); err != nil {
		fail(w, apierr.Internal("re-reading the saved settings failed: "+err.Error()))
		return
	}

	// The process holds its assembled config in memory, so most changes need a
	// restart. Saying so plainly beats a success message that implies otherwise.
	writeJSON(w, http.StatusOK, configResponse{
		Value:           updates,
		RestartRequired: true,
	})
}

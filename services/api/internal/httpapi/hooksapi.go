package httpapi

// Hook rules, their history, and a test button.
//
// Admin-only, all of it. A hook is an egress path -- it can send what this box
// sees to an arbitrary URL or mailbox -- so configuring one is administration
// of the machine rather than operation of it, and it sits behind the same role
// as changing who has an account.

import (
	"errors"
	"net/http"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/hooks"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/ulid"
)

type hookRulesResponse struct {
	Rules []hooks.Rule `json:"rules"`
	// Events and their descriptions, so the UI does not keep its own copy of
	// the closed set and drift from the server's.
	Events []hookEventDoc `json:"events"`
	// SMTPConfigured says whether the email action can work at all. Without it
	// the UI would offer an email hook on a unit with no mail server and only
	// report the problem when an alert failed to arrive.
	SMTPConfigured bool `json:"smtp_configured"`
}

type hookEventDoc struct {
	Event       string `json:"event"`
	Description string `json:"description"`
}

func (s *Server) handleListHookRules(w http.ResponseWriter, r *http.Request) {
	rules, err := s.store.ListHookRules(r.Context())
	if err != nil {
		fail(w, apierr.Internal("listing hook rules failed"))
		return
	}

	out := make([]hooks.Rule, 0, len(rules))
	for _, rule := range rules {
		// Redacted, always. A bearer token an admin set is write-only.
		out = append(out, rule.Redacted())
	}

	events := make([]hookEventDoc, 0, len(hooks.Events))
	for _, e := range hooks.Events {
		events = append(events, hookEventDoc{Event: e, Description: hooks.EventDoc[e]})
	}

	writeJSON(w, http.StatusOK, hookRulesResponse{
		Rules:          out,
		Events:         events,
		SMTPConfigured: s.hooks != nil && s.hooks.SMTP.Configured(),
	})
}

func (s *Server) handleCreateHookRule(w http.ResponseWriter, r *http.Request) {
	var rule hooks.Rule
	if err := decodeBody(r, &rule); err != nil {
		fail(w, err)
		return
	}

	rule.RuleID = ulid.New(s.now())
	rule.CreatedAt, rule.UpdatedAt = s.now(), s.now()
	rule.FireCount, rule.LastFiredAt = 0, nil

	if err := s.validateRule(&rule); err != nil {
		fail(w, err)
		return
	}
	if err := s.store.PutHookRule(r.Context(), rule); err != nil {
		fail(w, apierr.Internal("saving the hook rule failed"))
		return
	}
	writeJSON(w, http.StatusCreated, rule.Redacted())
}

func (s *Server) handleUpdateHookRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("rule_id")

	existing, err := s.store.GetHookRule(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no hook rule with id "+id))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("reading the hook rule failed"))
		return
	}

	var incoming hooks.Rule
	if err := decodeBody(r, &incoming); err != nil {
		fail(w, err)
		return
	}

	// Identity and history are the server's, not the client's.
	incoming.RuleID = existing.RuleID
	incoming.CreatedAt = existing.CreatedAt
	incoming.UpdatedAt = s.now()
	incoming.FireCount = existing.FireCount
	incoming.LastFiredAt = existing.LastFiredAt

	// A secret that comes back as the placeholder means "unchanged", not "set
	// it to bullets". Without this, editing a rule's name through the UI would
	// silently overwrite its bearer token with •••••••• and the hook would
	// start failing for a reason nobody could see.
	incoming.Config = mergeSecrets(existing.Config, incoming.Config)

	if err := s.validateRule(&incoming); err != nil {
		fail(w, err)
		return
	}
	if err := s.store.PutHookRule(r.Context(), incoming); err != nil {
		fail(w, apierr.Internal("saving the hook rule failed"))
		return
	}
	writeJSON(w, http.StatusOK, incoming.Redacted())
}

// mergeSecrets keeps an old secret when the client sent back the placeholder.
func mergeSecrets(old, incoming map[string]any) map[string]any {
	if incoming == nil {
		return old
	}
	out := make(map[string]any, len(incoming))
	for k, v := range incoming {
		if s, ok := v.(string); ok && s == "••••••••" {
			if prev, had := old[k]; had {
				out[k] = prev
				continue
			}
			// The placeholder with nothing behind it is not a value.
			continue
		}
		out[k] = v
	}
	return out
}

func (s *Server) validateRule(rule *hooks.Rule) *apierr.Error {
	if err := rule.Validate(); err != nil {
		field := "event"
		switch {
		case errors.Is(err, hooks.ErrUnknownAction):
			field = "action"
		case errors.Is(err, hooks.ErrUnknownEvent):
			field = "event"
		}
		return apierr.InvalidParameter(field, err.Error())
	}
	if s.hooks == nil {
		return apierr.Internal("the hook dispatcher is not running")
	}
	// Checked at configuration time, not at 3am when the alert it was meant to
	// send does not arrive.
	if err := s.hooks.ValidateRule(*rule); err != nil {
		return apierr.InvalidParameter("config", err.Error())
	}
	return nil
}

func (s *Server) handleDeleteHookRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("rule_id")
	err := s.store.DeleteHookRule(r.Context(), id)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrNotFound):
		fail(w, apierr.NotFound("no hook rule with id "+id))
	default:
		fail(w, apierr.Internal("deleting the hook rule failed"))
	}
}

type testHookResponse struct {
	Delivered    bool   `json:"delivered"`
	ResponseCode int    `json:"response_code,omitempty"`
	Error        string `json:"error,omitempty"`
}

// handleTestHookRule sends one message through a rule, right now.
//
// Bypasses the cooldown deliberately: a test button that silently did nothing
// because the rule happened to fire ten minutes ago would be worse than no test
// button. Synchronous, so the operator gets the actual error rather than having
// to go and read the delivery log.
func (s *Server) handleTestHookRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("rule_id")
	rule, err := s.store.GetHookRule(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no hook rule with id "+id))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("reading the hook rule failed"))
		return
	}
	if s.hooks == nil {
		fail(w, apierr.Internal("the hook dispatcher is not running"))
		return
	}

	code, derr := s.hooks.Test(r.Context(), rule)
	if derr != nil {
		writeJSON(w, http.StatusOK, testHookResponse{
			ResponseCode: code,
			Error:        derr.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, testHookResponse{Delivered: true, ResponseCode: code})
}

type hookDeliveriesResponse struct {
	Deliveries []hooks.Delivery `json:"deliveries"`
	// Dropped is events discarded because the dispatch queue was full. A silent
	// drop in an alerting system looks exactly like nothing happening, so it is
	// reported next to the history rather than only on /metrics.
	Dropped uint64 `json:"dropped"`
}

func (s *Server) handleListHookDeliveries(w http.ResponseWriter, r *http.Request) {
	limit, perr := intParam(r, "limit", 100, 1000)
	if perr != nil {
		fail(w, perr)
		return
	}
	list, err := s.store.ListHookDeliveries(r.Context(), limit)
	if err != nil {
		fail(w, apierr.Internal("listing hook deliveries failed"))
		return
	}
	if list == nil {
		list = []hooks.Delivery{}
	}
	var dropped uint64
	if s.hooks != nil {
		dropped = s.hooks.Dropped()
	}
	writeJSON(w, http.StatusOK, hookDeliveriesResponse{Deliveries: list, Dropped: dropped})
}

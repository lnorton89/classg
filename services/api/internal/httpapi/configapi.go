package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

const (
	configKeyChannels = "channels"
	configKeyWeights  = "weights"
)

// ChannelPlan mirrors services/sensor-wifi/config/channels.yaml.
type ChannelPlan struct {
	Channels []ChannelEntry `json:"channels"`
}

type ChannelEntry struct {
	Channel int     `json:"channel"`
	FreqMHz int     `json:"freq_mhz"`
	Weight  float64 `json:"weight"`
}

// WeightPlan is the fusion confidence weights from
// data-model.md#confidence-scoring.
type WeightPlan struct {
	Weights map[string]float64 `json:"weights"`
}

// configResponse carries the contract's restart_required flag.
type configResponse struct {
	Value           any  `json:"value"`
	RestartRequired bool `json:"restart_required"`
}

// defaultChannelPlan duplicates the shipped channels.yaml.
//
// Duplicated rather than parsed from that file because it belongs to
// sensor-wifi and reading it would mean a YAML dependency plus a
// cross-service file path that only resolves in a source checkout. This copy
// is the seed for a fresh database; once an operator PUTs a plan the stored
// value wins and this is never consulted again.
func defaultChannelPlan() ChannelPlan {
	return ChannelPlan{Channels: []ChannelEntry{
		{Channel: 6, FreqMHz: 2437, Weight: 40.0},
		{Channel: 1, FreqMHz: 2412, Weight: 15.0},
		{Channel: 11, FreqMHz: 2462, Weight: 15.0},
		{Channel: 2, FreqMHz: 2417, Weight: 1.7},
		{Channel: 3, FreqMHz: 2422, Weight: 1.7},
		{Channel: 4, FreqMHz: 2427, Weight: 1.7},
		{Channel: 5, FreqMHz: 2432, Weight: 1.7},
		{Channel: 7, FreqMHz: 2442, Weight: 1.7},
		{Channel: 8, FreqMHz: 2447, Weight: 1.7},
		{Channel: 9, FreqMHz: 2452, Weight: 1.7},
		{Channel: 10, FreqMHz: 2457, Weight: 1.7},
		{Channel: 12, FreqMHz: 2467, Weight: 1.05},
		{Channel: 13, FreqMHz: 2472, Weight: 1.05},
		{Channel: 36, FreqMHz: 5180, Weight: 3.0},
		{Channel: 40, FreqMHz: 5200, Weight: 2.0},
		{Channel: 44, FreqMHz: 5220, Weight: 3.0},
		{Channel: 48, FreqMHz: 5240, Weight: 2.0},
		{Channel: 149, FreqMHz: 5745, Weight: 3.0},
		{Channel: 157, FreqMHz: 5785, Weight: 2.0},
	}}
}

// defaultWeights duplicates fusion's DefaultWeights. Same reasoning as
// defaultChannelPlan: fusion is a separate Go module and importing it to read
// eight constants would couple the two services' build graphs.
func defaultWeights() WeightPlan {
	return WeightPlan{Weights: map[string]float64{
		"A": 0.60, "B": 0.50, "C": 0.10, "D": 0.00,
		"E": 0.30, "F": 0.25, "G": 0.60, "H": 0.00,
	}}
}

func (s *Server) handleGetChannels(w http.ResponseWriter, r *http.Request) {
	var plan ChannelPlan
	raw, err := s.store.GetConfig(r.Context(), configKeyChannels)
	switch {
	case errors.Is(err, store.ErrNotFound):
		plan = defaultChannelPlan()
	case err != nil:
		fail(w, apierr.Internal("loading channel plan failed"))
		return
	default:
		if err := json.Unmarshal(raw, &plan); err != nil {
			fail(w, apierr.Internal("stored channel plan is corrupt"))
			return
		}
	}
	writeJSON(w, http.StatusOK, configResponse{Value: plan, RestartRequired: false})
}

func (s *Server) handlePutChannels(w http.ResponseWriter, r *http.Request) {
	var plan ChannelPlan
	if err := decodeBody(r, &plan); err != nil {
		fail(w, err)
		return
	}
	if err := validateChannelPlan(plan); err != nil {
		fail(w, err)
		return
	}
	raw, _ := json.Marshal(plan)
	if err := s.store.PutConfig(r.Context(), configKeyChannels, raw); err != nil {
		fail(w, apierr.Internal("saving channel plan failed"))
		return
	}
	// restart_required is true because the api has no way to push a plan to a
	// sensor. Sensors do now hold a SUB socket -- ADR-0010 lets a receiver watch
	// fusion's track stream to tell whether its companion radio is busy -- but
	// that subscription deliberately carries no configuration: a plan arriving
	// over the bus would make the running configuration unobservable, which is
	// what ADR-0007's tiers exist to prevent. It becomes false the day sensors
	// gain a CONFIG subscription, which is a different decision.
	//
	// Understating it, in the same way the weights endpoint below does: a
	// restart re-reads the receiver's channel FILE, which nothing here writes,
	// so it does not apply this plan either. Nor is there one file to write --
	// the deployed units run config/channels-primary.yaml on wifi-0 and
	// config/channels-sweep.yaml on the wifi-1 sweep receiver, deliberately
	// split so the two adapters do not duplicate each other's coverage. The
	// calibration page says "recorded, not applied" rather than repeating this
	// flag as though a restart were enough.
	writeJSON(w, http.StatusOK, configResponse{Value: plan, RestartRequired: true})
}

func validateChannelPlan(plan ChannelPlan) error {
	if len(plan.Channels) == 0 {
		return apierr.InvalidParameter("channels", "channels must contain at least one entry")
	}
	seen := map[int]bool{}
	total := 0.0
	for i, c := range plan.Channels {
		field := fmt.Sprintf("channels[%d]", i)
		if !allowedChannel(c.Channel) {
			return apierr.InvalidParameter(field+".channel",
				fmt.Sprintf("channel %d is not a listenable Wi-Fi channel", c.Channel))
		}
		if seen[c.Channel] {
			return apierr.InvalidParameter(field+".channel",
				fmt.Sprintf("channel %d appears more than once", c.Channel))
		}
		seen[c.Channel] = true
		if c.Weight < 0 {
			return apierr.InvalidParameter(field+".weight", "weight must not be negative")
		}
		if c.FreqMHz != 0 && (c.FreqMHz < 2400 || c.FreqMHz > 5900) {
			return apierr.InvalidParameter(field+".freq_mhz",
				fmt.Sprintf("freq_mhz %d is outside the 2.4/5 GHz bands this sensor listens on", c.FreqMHz))
		}
		total += c.Weight
	}
	if total <= 0 {
		// Every weight zero means the hopper would never dwell anywhere, which
		// silently disables detection entirely.
		return apierr.InvalidParameter("channels", "at least one channel must have a weight above zero")
	}
	return nil
}

// allowedChannel mirrors the capture package's allowlist. 6 GHz is absent
// deliberately: the US regdb marks it NO-IR, which disables passive listening.
func allowedChannel(ch int) bool {
	if ch >= 1 && ch <= 14 {
		return true
	}
	for _, c := range []int{36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 149, 153, 157, 161, 165} {
		if ch == c {
			return true
		}
	}
	return false
}

func (s *Server) handleGetWeights(w http.ResponseWriter, r *http.Request) {
	var plan WeightPlan
	raw, err := s.store.GetConfig(r.Context(), configKeyWeights)
	switch {
	case errors.Is(err, store.ErrNotFound):
		plan = defaultWeights()
	case err != nil:
		fail(w, apierr.Internal("loading weights failed"))
		return
	default:
		if err := json.Unmarshal(raw, &plan); err != nil {
			fail(w, apierr.Internal("stored weights are corrupt"))
			return
		}
	}
	writeJSON(w, http.StatusOK, configResponse{Value: plan, RestartRequired: false})
}

func (s *Server) handlePutWeights(w http.ResponseWriter, r *http.Request) {
	var plan WeightPlan
	if err := decodeBody(r, &plan); err != nil {
		fail(w, err)
		return
	}
	if err := validateWeights(plan); err != nil {
		fail(w, err)
		return
	}
	raw, _ := json.Marshal(plan)
	if err := s.store.PutConfig(r.Context(), configKeyWeights, raw); err != nil {
		fail(w, apierr.Internal("saving weights failed"))
		return
	}
	// Like channels, only worse: fusion does not read a weights file at all. It
	// starts from fusion.DefaultWeights(), compiled in, and has no path to this
	// plan -- so a restart will not apply it either, and restart_required is
	// understating it rather than describing it. What is stored here is what
	// the weights SHOULD be. The calibration page says exactly that instead of
	// showing a saved value as though it were live; see data-model.md.
	writeJSON(w, http.StatusOK, configResponse{Value: plan, RestartRequired: true})
}

func validateWeights(plan WeightPlan) error {
	if len(plan.Weights) == 0 {
		return apierr.InvalidParameter("weights", "weights must contain at least one class")
	}
	classes := make([]string, 0, len(plan.Weights))
	for c := range plan.Weights {
		classes = append(classes, c)
	}
	sort.Strings(classes) // deterministic error for a body with several problems
	for _, c := range classes {
		field := "weights." + c
		if !model.DetectionClasses[c] {
			return apierr.InvalidParameter(field, "unknown detection class "+c+" (valid: A-H)")
		}
		w := plan.Weights[c]
		if w < 0 || w > 1 {
			return apierr.InvalidParameter(field, "weight must be between 0 and 1")
		}
		// A weight of 1 makes noisy-OR saturate: one detection of that class
		// alone would produce confidence 1.0 and no other evidence could ever
		// change it. data-model.md is explicit that no single class may be
		// gameable into a certain confirm.
		if w == 1 {
			return apierr.InvalidParameter(field,
				"weight must be below 1: a weight of 1 makes a single detection of class "+c+
					" produce certainty, which noisy-OR is specifically chosen to prevent")
		}
	}
	return nil
}

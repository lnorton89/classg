// Package hooks fires an action when something happens.
//
// Modelled on how alerting works in the systems this most resembles -- Grafana's
// rule/contact-point split, Frigate's MQTT events, Sonarr's "connect", UniFi
// Protect's alarm triggers. The shape they converge on is: a rule names an
// event, narrows it with conditions, and points at an action. That is what this
// is.
//
// Four things here are not obvious and are the difference between an alerting
// system and a nuisance:
//
// **Cooldown is per rule and per subject, not per rule.** One aircraft
// generates detections several times a second. A rule with a single cooldown
// would either flood on the first drone or go silent for the second, and
// "silent for the second" is the failure that matters. Keying on the subject --
// the track, the sensor, the capture -- means one alert per drone, and a
// genuinely new drone alerts immediately even if another is still in the air.
//
// **Delivery never blocks ingest.** Detections arrive off a ZMQ socket with a
// high-water mark; an SMTP server that takes thirty seconds to answer must not
// become backpressure on the thing that sees drones. Everything is queued and
// dispatched on its own goroutines, and a full queue drops and counts rather
// than waiting (ADR-0002's rule, applied one layer up).
//
// **Operator location goes through the same allowlist as everything else.**
// A hook is an egress path. It would be a hole in GDPR-relevant handling if
// CLASSG_EXPOSE_OPERATOR_LOCATION could be respected by the API and ignored by
// a webhook -- so payloads are redacted centrally, before an action ever sees
// them.
//
// **A URL from an admin is still a URL.** Webhook targets are validated against
// SSRF: no loopback, no link-local, no private ranges unless explicitly
// allowed. An admin who can point a hook at 169.254.169.254 can read a cloud
// metadata service through this box.
package hooks

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Event names. Closed set: a rule naming something else is a typo, and a typo
// that silently never fires is worse than one that is rejected.
const (
	EventDetection       = "detection.created"
	EventTrackConfirmed  = "track.confirmed"
	EventTrackClosed     = "track.closed"
	EventSensorUnhealthy = "sensor.unhealthy"
	EventSensorRecovered = "sensor.recovered"
	EventCaptureDone     = "capture.completed"
	EventSweepDone       = "sweep.completed"
)

// Events is the closed set, in the order a UI should offer them.
var Events = []string{
	EventTrackConfirmed,
	EventTrackClosed,
	EventDetection,
	EventSensorUnhealthy,
	EventSensorRecovered,
	EventCaptureDone,
	EventSweepDone,
}

// EventDoc is what each event means, shown in the UI so a rule is chosen on
// purpose rather than by guessing from the name.
var EventDoc = map[string]string{
	EventTrackConfirmed: "A track crossed the confidence threshold and is now CONFIRMED. " +
		"This is the one most alerting wants: one alert per aircraft, not per frame.",
	EventTrackClosed: "A track went away -- it stopped being seen and aged out.",
	EventDetection: "Every single detection. High volume: one aircraft produces several " +
		"a second, so pair this with conditions and expect the cooldown to do real work.",
	EventSensorUnhealthy: "A sensor stopped being healthy -- a vanished adapter, a dead " +
		"dump1090, a wedged radio.",
	EventSensorRecovered: "A sensor that was unhealthy started reporting again.",
	EventCaptureDone:     "A packet capture finished.",
	EventSweepDone:       "A band sweep finished measuring.",
}

func ValidEvent(e string) bool {
	for _, known := range Events {
		if known == e {
			return true
		}
	}
	return false
}

// Action kinds.
const (
	ActionWebhook = "webhook"
	ActionEmail   = "email"
)

var Actions = []string{ActionWebhook, ActionEmail}

// Rule is one "when X, do Y".
type Rule struct {
	RuleID  string `json:"rule_id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	Event   string `json:"event"`

	// --- conditions, all optional and ANDed ---

	// MinConfidence filters track events. 0 means no filter.
	MinConfidence float64 `json:"min_confidence,omitempty"`
	// Classes filters on detection class (A..H). Empty means any.
	Classes []string `json:"classes,omitempty"`
	// SensorKinds filters on wifi/sdr/ble. Empty means any.
	SensorKinds []string `json:"sensor_kinds,omitempty"`
	// OnlyDrones excludes ADS-B manned traffic, which is the overwhelming
	// majority of what this box sees and almost never what an alert is for.
	OnlyDrones bool `json:"only_drones,omitempty"`

	// CooldownS suppresses repeats for the same subject. Zero means the
	// default, not "no cooldown" -- a rule with no cooldown on a per-detection
	// event will send thousands of messages, and nobody means that.
	CooldownS int `json:"cooldown_s"`

	Action string `json:"action"`
	// Config is action-specific. Secret fields are stripped on read -- see
	// Redacted.
	Config map[string]any `json:"config"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// LastFiredAt and FireCount make a rule's behaviour visible. A rule that
	// has never fired is usually a rule whose conditions do not match anything,
	// and without this that is invisible until someone needs the alert.
	LastFiredAt *time.Time `json:"last_fired_at,omitempty"`
	FireCount   int64      `json:"fire_count"`
}

// DefaultCooldownS is what a rule gets when it does not choose.
//
// Five minutes. Long enough that one aircraft is one alert, short enough that a
// second aircraft ten minutes later is a second alert. Per subject, so this
// never delays an alert about a different drone.
const DefaultCooldownS = 300

// SecretConfigKeys never come back out of the API.
//
// A webhook Authorization header and an SMTP password are write-only: an admin
// can set them and can replace them, and nobody -- including another admin --
// can read them back through the API. That is the same rule the Turso token
// follows in /system.
var SecretConfigKeys = map[string]bool{
	"authorization": true,
	"auth_header":   true,
	"bearer_token":  true,
	"password":      true,
	"secret":        true,
	"token":         true,
}

// Redacted returns a copy safe to serialise to a client.
func (r Rule) Redacted() Rule {
	if r.Config == nil {
		return r
	}
	clean := make(map[string]any, len(r.Config))
	for k, v := range r.Config {
		if SecretConfigKeys[strings.ToLower(k)] {
			// Present-but-hidden rather than absent: the UI needs to show that
			// a token IS set without showing what it is, or an admin cannot
			// tell a configured hook from an unconfigured one.
			clean[k] = "••••••••"
			continue
		}
		clean[k] = v
	}
	r.Config = clean
	return r
}

// Delivery is one attempt to fire a rule.
type Delivery struct {
	DeliveryID string    `json:"delivery_id"`
	RuleID     string    `json:"rule_id"`
	RuleName   string    `json:"rule_name,omitempty"`
	Event      string    `json:"event"`
	Subject    string    `json:"subject,omitempty"`
	Status     string    `json:"status"`
	Attempts   int       `json:"attempts"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	// CompletedAt is nil while pending.
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	// ResponseCode is the HTTP status a webhook returned, when there was one.
	ResponseCode int `json:"response_code,omitempty"`
}

const (
	DeliveryPending   = "pending"
	DeliveryDelivered = "delivered"
	DeliveryFailed    = "failed"
	// DeliverySuppressed is a rule that matched but was inside its cooldown.
	// Recorded rather than dropped silently: "why did I not get an alert" is a
	// question an operator will ask, and this is the answer.
	DeliverySuppressed = "suppressed"
)

// Event is one thing that happened, before any rule has looked at it.
type Event struct {
	Name string `json:"event"`
	// Subject is what the cooldown keys on -- a track id, a sensor id, a
	// capture id. Two different drones have two different subjects and do not
	// suppress each other.
	Subject string    `json:"subject"`
	At      time.Time `json:"at"`
	// Payload is what an action sends. Already redacted.
	Payload map[string]any `json:"payload"`

	// The fields conditions are evaluated against, lifted out so a rule does
	// not have to reach into an untyped payload.
	Confidence float64
	Class      string
	SensorKind string
	IsDrone    bool
}

var (
	ErrUnknownEvent  = errors.New("unknown event")
	ErrUnknownAction = errors.New("unknown action")
	ErrBadConfig     = errors.New("invalid action configuration")
)

// Validate checks a rule before it is stored.
func (r *Rule) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return errors.New("a rule needs a name")
	}
	if !ValidEvent(r.Event) {
		return fmt.Errorf("%w: %q", ErrUnknownEvent, r.Event)
	}
	switch r.Action {
	case ActionWebhook, ActionEmail:
	default:
		return fmt.Errorf("%w: %q", ErrUnknownAction, r.Action)
	}
	if r.MinConfidence < 0 || r.MinConfidence > 1 {
		return errors.New("min_confidence must be between 0 and 1")
	}
	if r.CooldownS < 0 {
		return errors.New("cooldown_s cannot be negative")
	}
	if r.CooldownS == 0 {
		r.CooldownS = DefaultCooldownS
	}
	for _, c := range r.Classes {
		if len(c) != 1 || c[0] < 'A' || c[0] > 'H' {
			return fmt.Errorf("%q is not a detection class (A to H)", c)
		}
	}
	return nil
}

// Matches reports whether an event satisfies this rule's conditions.
func (r Rule) Matches(e Event) bool {
	if !r.Enabled || r.Event != e.Name {
		return false
	}
	if r.MinConfidence > 0 && e.Confidence < r.MinConfidence {
		return false
	}
	if r.OnlyDrones && !e.IsDrone {
		return false
	}
	if len(r.Classes) > 0 && !contains(r.Classes, e.Class) {
		return false
	}
	if len(r.SensorKinds) > 0 && !contains(r.SensorKinds, e.SensorKind) {
		return false
	}
	return true
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if strings.EqualFold(v, want) {
			return true
		}
	}
	return false
}

// ConfigString reads a string out of an action config.
func (r Rule) ConfigString(key string) string {
	if r.Config == nil {
		return ""
	}
	if v, ok := r.Config[key].(string); ok {
		return v
	}
	return ""
}

// MarshalPayload is what actually goes on the wire to a webhook.
func MarshalPayload(e Event, rule Rule) ([]byte, error) {
	return json.Marshal(map[string]any{
		"event":   e.Name,
		"at":      e.At.UTC().Format(time.RFC3339),
		"rule":    map[string]any{"rule_id": rule.RuleID, "name": rule.Name},
		"subject": e.Subject,
		"data":    e.Payload,
		"source":  "classg",
	})
}

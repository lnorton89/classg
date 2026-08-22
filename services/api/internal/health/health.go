// Package health answers the one question this system exists to answer
// correctly: is the sky quiet, or is the detector broken?
//
// A drone detector that stops detecting silently manufactures false
// confidence, which is worse than one that is visibly offline (ADR-0003). The
// whole design here follows from that: sensors are known from configuration as
// well as from traffic, so a sensor that never started is reported as
// unhealthy rather than being absent from the list, and "absent" never gets to
// masquerade as "nothing flying".
package health

import (
	"sort"
	"sync"
	"time"
)

const (
	StatusOK       = "ok"
	StatusDegraded = "degraded"
	StatusDown     = "down"
)

// Heartbeat is what a sensor publishes on the bus at a fixed interval,
// regardless of whether it detected anything.
type Heartbeat struct {
	SensorID   string    `json:"sensor_id"`
	SensorKind string    `json:"sensor_kind"`
	Healthy    bool      `json:"healthy"`
	TS         time.Time `json:"-"`
	// At is when this api observed the heartbeat, by its own clock. Liveness is
	// a local observation -- "have I heard from it lately" -- and deriving it
	// from TS instead means subtracting the sensor's clock from ours. Zero falls
	// back to TS, which is what the tests and Restore rely on.
	At     time.Time      `json:"-"`
	Detail map[string]any `json:"detail"`
}

// Sensor is one entry in the /health sensors array.
type Sensor struct {
	SensorID              string         `json:"sensor_id"`
	SensorKind            string         `json:"sensor_kind"`
	Healthy               bool           `json:"healthy"`
	LastHeartbeat         *time.Time     `json:"last_heartbeat"`
	SecondsSinceHeartbeat *int64         `json:"seconds_since_heartbeat"`
	Detections5m          int            `json:"detections_5m"`
	Reason                string         `json:"reason,omitempty"`
	Detail                map[string]any `json:"detail,omitempty"`
	// Optional reports that this sensor was declared as hardware the unit may
	// not have fitted. Additive: consumers that ignore it see exactly what they
	// saw before.
	Optional bool `json:"optional,omitempty"`
}

// FusionLink reports whether the api is actually receiving from fusion.
//
// This is an additive field beyond the contract's example. It is here because
// the contract's own stated purpose for /health -- distinguishing a quiet sky
// from a broken detector -- is not served by sensor health alone: every sensor
// can be heartbeating happily while the track pipeline is dead, and the
// resulting empty map would look exactly like a quiet sky. sensor_kind is a
// closed enum of wifi|sdr|ble, so fusion cannot be reported as a sensor.
// Flagged in docs/architecture/api-implementation.md.
type FusionLink struct {
	Configured  bool       `json:"configured"`
	Connected   bool       `json:"connected"`
	LastMessage *time.Time `json:"last_message,omitempty"`
	Reason      string     `json:"reason,omitempty"`
}

type Report struct {
	Status  string     `json:"status"`
	UptimeS int64      `json:"uptime_s"`
	Version string     `json:"version"`
	Sensors []Sensor   `json:"sensors"`
	Fusion  FusionLink `json:"fusion"`
}

type entry struct {
	kind string
	// last is what the sensor said the time was; it is reported verbatim as
	// last_heartbeat and never used for arithmetic.
	last time.Time
	// observed is when we heard it, by our clock. Staleness is measured from
	// this so a sensor with a skewed clock cannot talk its way out of being
	// declared dead.
	observed time.Time
	healthy  bool
	reason   string
	detail   map[string]any
	// seen is false for a sensor that was declared in configuration but has
	// never published a heartbeat.
	seen bool
	// optional marks hardware this unit may not have fitted. Only meaningful
	// while seen is false; see Snapshot.
	optional bool
}

// Registry tracks sensor liveness.
type Registry struct {
	mu         sync.RWMutex
	sensors    map[string]*entry
	staleAfter time.Duration

	fusionConfigured bool
	fusionConnected  bool
	fusionLast       time.Time
	fusionReason     string
}

func NewRegistry(staleAfter time.Duration) *Registry {
	return &Registry{sensors: map[string]*entry{}, staleAfter: staleAfter}
}

// Expect declares a sensor that ought to exist. Called once at startup from
// CLASSG_EXPECTED_SENSORS.
//
// optional declares hardware the unit may not have fitted -- an SDR or a BLE
// dongle on a build that ships without one. It suppresses nothing except the
// "never reported at all" case; see Snapshot.
//
// It is weaker for a Wi-Fi receiver, and deliberately: the two Wi-Fi radios
// share a split channel plan, so a declared one that never reports is a hole in
// the coverage rather than a build option, and Snapshot counts it unless the
// surviving receiver says it widened. Declare wifi-1 only on a unit that is
// meant to have two.
func (r *Registry) Expect(sensorID, kind string, optional bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.sensors[sensorID]; ok {
		return
	}
	r.sensors[sensorID] = &entry{kind: kind, optional: optional}
}

// Restore seeds the registry from persisted state so a sensor that was known
// before an api restart is still reported -- as unhealthy and stale, which is
// the truth until it heartbeats again.
func (r *Registry) Restore(sensorID, kind string, last time.Time, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.sensors[sensorID]
	if !ok {
		e = &entry{kind: kind}
		r.sensors[sensorID] = e
	}
	if last.After(e.last) {
		e.last = last
		// Nothing was observed locally -- this sensor last spoke to a previous
		// process. The persisted wall-clock time is the only age available, and
		// it is the honest one: however old it really is, that is how long this
		// api has not heard from it.
		e.observed = last
		e.seen = true
		e.reason = reason
	}
}

func (r *Registry) Heartbeat(hb Heartbeat) {
	if hb.SensorID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.sensors[hb.SensorID]
	if !ok {
		e = &entry{}
		r.sensors[hb.SensorID] = e
	}
	if hb.SensorKind != "" {
		e.kind = hb.SensorKind
	}
	e.seen = true
	e.last = hb.TS
	e.observed = hb.At
	if e.observed.IsZero() {
		e.observed = hb.TS
	}
	e.healthy = hb.Healthy
	e.detail, e.reason = splitReason(hb.Detail)
}

// splitReason lifts a human-readable reason out of the sensor's detail blob.
//
// The Wi-Fi sensor reports why it is unhealthy inside detail (see
// classg_wifi/bus.py), but the contract puts `reason` alongside `healthy`.
// Promote it and leave the rest of detail intact.
func splitReason(detail map[string]any) (map[string]any, string) {
	if len(detail) == 0 {
		return nil, ""
	}
	var reason string
	out := make(map[string]any, len(detail))
	for k, v := range detail {
		if k == "reason" {
			if s, ok := v.(string); ok {
				reason = s
				continue
			}
		}
		out[k] = v
	}
	if len(out) == 0 {
		out = nil
	}
	return out, reason
}

func (r *Registry) SetFusionState(configured, connected bool, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fusionConfigured = configured
	r.fusionConnected = connected
	r.fusionReason = reason
}

func (r *Registry) NoteFusionMessage(at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fusionLast = at
	r.fusionConnected = true
	r.fusionReason = ""
}

// Snapshot builds the /health payload. detections5m comes from the store,
// keyed by sensor_id.
//
// now is this api's current time and is used only for arithmetic against
// observed heartbeat times, never for display. Pass it straight from
// time.Now(): a value that has been through .UTC() has lost its monotonic
// reading, and sensor ages then move whenever the system clock is corrected.
func (r *Registry) Snapshot(now time.Time, uptime time.Duration, version string, detections5m map[string]int) Report {
	r.mu.RLock()
	defer r.mu.RUnlock()

	rep := Report{
		UptimeS: int64(uptime / time.Second),
		Version: version,
		Sensors: []Sensor{},
		Fusion: FusionLink{
			Configured: r.fusionConfigured,
			Connected:  r.fusionConnected,
			Reason:     r.fusionReason,
		},
	}
	if !r.fusionLast.IsZero() {
		last := r.fusionLast
		rep.Fusion.LastMessage = &last
	}

	// A second Wi-Fi receiver is not optional in the way a second radio kind is:
	// the two share a split channel plan, so losing one leaves the other running
	// a plan that was written assuming coverage it no longer has.
	coverageWhole := r.wifiCoverageIsWhole(now)

	healthy, total := 0, 0
	for id, e := range r.sensors {
		s := Sensor{
			SensorID:     id,
			SensorKind:   e.kind,
			Detections5m: detections5m[id],
			Detail:       e.detail,
			Reason:       e.reason,
			Optional:     e.optional,
		}
		switch {
		case !e.seen:
			s.Healthy = false
			if s.Reason == "" {
				switch {
				case !e.optional:
					s.Reason = "no heartbeat since the api started"
				case e.kind == "wifi" && !coverageWhole:
					// Deliberately does not claim which: from here, an adapter
					// that was never plugged in and one whose unit was never
					// enabled look identical, and both leave the same hole.
					s.Reason = "not fitted, or its unit was never enabled; " +
						"the remaining Wi-Fi receiver is running a split " +
						"channel plan, so part of the plan is unwatched"
				case e.kind == "wifi":
					s.Reason = "not fitted; the remaining Wi-Fi receiver " +
						"widened to the full channel plan"
				default:
					s.Reason = "not fitted"
				}
			}
		default:
			last := e.last
			s.LastHeartbeat = &last
			age := now.Sub(e.observed)
			secs := int64(age / time.Second)
			s.SecondsSinceHeartbeat = &secs
			stale := age > r.staleAfter
			s.Healthy = e.healthy && !stale
			if stale && s.Reason == "" {
				s.Reason = "heartbeat stale"
			}
		}
		// Optional hardware that has never reported is a supported build, not a
		// fault, so it is listed but not counted. Counting it would leave a Pi
		// with no SDR permanently `degraded`, and an operator who learns to
		// ignore a standing warning will ignore a real one -- the same false
		// confidence, arrived at from the opposite direction.
		//
		// The moment it HAS reported, e.seen is true and it counts like any
		// other sensor: a radio that worked and stopped is exactly what this
		// endpoint exists to surface.
		uncounted := e.optional && !e.seen

		// Except for a declared second Wi-Fi receiver, which is a different
		// kind of absence. A missing SDR costs this unit the sensor it never
		// had; a missing Wi-Fi receiver costs it channels the OTHER receiver
		// stopped covering when the plans were split -- all of 5 GHz, or
		// channel 6, depending which one is gone. Declaring it is the operator
		// saying this unit has two, so `not fitted` is not an answer.
		//
		// Unless the survivor widened, which is the supported single-adapter
		// build and genuinely fine. Then the standing-warning objection above
		// applies with full force and this stays uncounted.
		if uncounted && e.kind == "wifi" && !coverageWhole {
			uncounted = false
		}
		if uncounted {
			rep.Sensors = append(rep.Sensors, s)
			continue
		}
		total++
		if s.Healthy {
			healthy++
		}
		rep.Sensors = append(rep.Sensors, s)
	}
	sort.Slice(rep.Sensors, func(i, j int) bool { return rep.Sensors[i].SensorID < rep.Sensors[j].SensorID })

	rep.Status = status(healthy, total, r.fusionConfigured, r.fusionConnected)
	return rep
}

// wifiCoverageIsWhole reports whether some live Wi-Fi receiver says it is
// covering the full channel plan by itself.
//
// The dual-receiver channel plans are partial on purpose: channels-primary.yaml
// is 6/1/11 because channels-sweep.yaml takes the rest, and channels-sweep.yaml
// omits channel 6 because the primary camps there. A receiver that starts with
// no companion widens to the full plan and says so in its heartbeat
// (capture.PlanChoice) -- which is the only way this process can learn it,
// since sensors publish and never answer questions (ADR-0002).
//
// Absence of the signal is read as "not proven", not as "fine". A sensor too old
// to send the field, or one started by hand without the fallback configured,
// gets a warning that may be unnecessary rather than a silence that may be
// false confidence -- the direction this whole package leans.
//
// Staleness is applied here and not just e.healthy, because e.healthy is what
// the sensor last SAID about itself. A radio that was unplugged an hour ago
// left a cheerful heartbeat behind, and without the age check that message
// keeps vouching for coverage nothing is providing any more -- the same
// last-word-wins failure the rest of this package exists to prevent.
//
// Caller must hold r.mu.
func (r *Registry) wifiCoverageIsWhole(now time.Time) bool {
	for _, e := range r.sensors {
		if e.kind != "wifi" || !e.seen || !e.healthy {
			continue
		}
		if now.Sub(e.observed) > r.staleAfter {
			continue
		}
		if widened, ok := e.detail["plan_fallback"].(bool); ok && widened {
			return true
		}
	}
	return false
}

// status implements the contract's rule -- degraded when some sensors are
// unhealthy, down when none are healthy -- with two additions.
//
// No sensors at all is `down`, not `ok`: an api that knows about no sensors
// has no basis to claim anything about the sky, and reporting ok would be the
// exact false confidence this endpoint exists to prevent.
//
// A configured-but-disconnected fusion caps the result at `degraded` for the
// same reason: sensors can be perfectly healthy while nothing is producing
// tracks, and the resulting empty map is indistinguishable from a quiet sky.
func status(healthy, total int, fusionConfigured, fusionConnected bool) string {
	var s string
	switch {
	case total == 0:
		s = StatusDown
	case healthy == 0:
		s = StatusDown
	case healthy < total:
		s = StatusDegraded
	default:
		s = StatusOK
	}
	if fusionConfigured && !fusionConnected && s == StatusOK {
		s = StatusDegraded
	}
	return s
}

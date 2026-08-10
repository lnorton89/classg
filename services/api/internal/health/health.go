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
	SensorID   string         `json:"sensor_id"`
	SensorKind string         `json:"sensor_kind"`
	Healthy    bool           `json:"healthy"`
	TS         time.Time      `json:"-"`
	Detail     map[string]any `json:"detail"`
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
	kind    string
	last    time.Time
	healthy bool
	reason  string
	detail  map[string]any
	// seen is false for a sensor that was declared in configuration but has
	// never published a heartbeat.
	seen bool
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
func (r *Registry) Expect(sensorID, kind string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.sensors[sensorID]; ok {
		return
	}
	r.sensors[sensorID] = &entry{kind: kind}
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

	healthy, total := 0, 0
	for id, e := range r.sensors {
		total++
		s := Sensor{
			SensorID:     id,
			SensorKind:   e.kind,
			Detections5m: detections5m[id],
			Detail:       e.detail,
			Reason:       e.reason,
		}
		switch {
		case !e.seen:
			s.Healthy = false
			if s.Reason == "" {
				s.Reason = "no heartbeat since the api started"
			}
		default:
			last := e.last
			s.LastHeartbeat = &last
			secs := int64(now.Sub(e.last) / time.Second)
			s.SecondsSinceHeartbeat = &secs
			stale := now.Sub(e.last) > r.staleAfter
			s.Healthy = e.healthy && !stale
			if stale && s.Reason == "" {
				s.Reason = "heartbeat stale"
			}
		}
		if s.Healthy {
			healthy++
		}
		rep.Sensors = append(rep.Sensors, s)
	}
	sort.Slice(rep.Sensors, func(i, j int) bool { return rep.Sensors[i].SensorID < rep.Sensors[j].SensorID })

	rep.Status = status(healthy, total, r.fusionConfigured, r.fusionConnected)
	return rep
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

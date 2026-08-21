// Package ingest wires the ZeroMQ bus to storage, the health registry and the
// WebSocket hub.
//
// It is the only writer. Everything downstream -- HTTP handlers, the stream --
// reads what this package produced, which is what makes "the API is the only
// writer" in api-contract.md#principles true rather than aspirational.
package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/hooks"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/monitoring"
	"github.com/classg/api/internal/store"
)

type Ingestor struct {
	Store    store.Store
	Registry *health.Registry
	Hub      *hub.Hub
	// MaxHistory bounds the position history persisted per track. fusion keeps
	// a ring buffer of its own; this stops a long-lived track from growing the
	// stored document without limit on an SD card.
	//
	// Keep it at or above fusion's HistoryDepth. Below it, this trim -- not
	// fusion's -- is what an operator actually sees, and the trail goes missing
	// from the map and from storage while fusion is still holding the points.
	MaxHistory int
	// ExposeOperatorLocation gates whether operator positions reach clients.
	ExposeOperatorLocation bool
	// Monitoring is the always-on recording switch. When paused, detections
	// and tracks are discarded at this boundary rather than stopping the
	// radio -- see internal/monitoring for why.
	Monitoring *monitoring.Switch

	// lastHealth is the previous healthy flag per sensor, so a hook fires on
	// the transition rather than on every heartbeat.
	healthMu   sync.Mutex
	lastHealth map[string]bool

	// Hooks fires alert rules. Nil when none are configured.
	//
	// Deliberately fed from the SAME redacted value that goes to the hub, not
	// from the raw track. A hook is an egress path, and it would be a hole in
	// GDPR-relevant handling if CLASSG_EXPOSE_OPERATOR_LOCATION were respected
	// by the websocket and ignored by a webhook.
	Hooks HookFirer
}

// HookFirer is the dispatcher, narrowed to what ingest needs. An interface so
// this package does not depend on internal/hooks, and so a nil is a no-op
// rather than a special case at every call site.
type HookFirer interface {
	Fire(e hooks.Event)
}

// fireHook is nil-safe.
func (in *Ingestor) fireHook(e hooks.Event) {
	if in.Hooks == nil {
		return
	}
	// Fire never blocks; see internal/hooks. That guarantee is what makes it
	// safe to call from the ingest path at all.
	in.Hooks.Fire(e)
}

// isDrone reports whether a track is something other than manned traffic.
//
// ADS-B (class D) is the overwhelming majority of what this box sees and almost
// never what an alert is for, so rules can exclude it. A track correlated with
// ADS-B is an aircraft squawking its identity, which a drone flying ELRS is
// not.
func isDrone(t model.Track) bool {
	if t.ADSBCorrelated {
		return false
	}
	for _, e := range t.Evidence {
		if e.Class == "D" {
			return false
		}
	}
	return true
}

// recording reports whether to keep what arrives. A nil Switch means always
// recording, so nothing that constructs an Ingestor without one goes silent.
func (in *Ingestor) recording() bool {
	return in.Monitoring == nil || in.Monitoring.Enabled()
}

// Track handles one message from fusion's track topic.
func (in *Ingestor) Track(ctx context.Context, topic string, body []byte) {
	if !in.recording() {
		in.Monitoring.NoteDiscarded()
		return
	}
	// track.closed carries only an id, so try that shape first.
	if strings.HasSuffix(topic, "closed") {
		var closed struct {
			TrackID string `json:"track_id"`
		}
		if err := json.Unmarshal(body, &closed); err == nil && closed.TrackID != "" {
			t, err := in.Store.GetTrack(ctx, closed.TrackID)
			switch {
			case err == nil:
				t.State = "CLOSED"
				if err := in.Store.UpsertTrack(ctx, t); err != nil {
					slog.Error("archiving closed track failed", "track_id", closed.TrackID, "err", err)
				}
			case errors.Is(err, store.ErrNotFound):
				slog.Warn("closed track was not present in storage", "track_id", closed.TrackID)
			default:
				slog.Error("loading track for closure failed", "track_id", closed.TrackID, "err", err)
			}
			in.Registry.NoteFusionMessage(time.Now().UTC())
			in.Hub.Broadcast(hub.Frame{Type: hub.TypeTrackClosed, TrackID: closed.TrackID})
			in.fireHook(hooks.Event{
				Name: hooks.EventTrackClosed, Subject: closed.TrackID,
				At:      time.Now().UTC(),
				Payload: map[string]any{"track_id": closed.TrackID},
			})
			return
		}
	}

	t, err := model.DecodeTrack(body)
	if err != nil {
		slog.Warn("dropping malformed track from the bus", "topic", topic, "err", err)
		return
	}
	if in.MaxHistory > 0 && len(t.History) > in.MaxHistory {
		t.History = t.History[len(t.History)-in.MaxHistory:]
	}
	if t.State == "CLOSED" {
		if err := in.Store.UpsertTrack(ctx, t); err != nil {
			slog.Error("archiving closed track failed", "track_id", t.TrackID, "err", err)
		}
		in.Registry.NoteFusionMessage(time.Now().UTC())
		in.Hub.Broadcast(hub.Frame{Type: hub.TypeTrackClosed, TrackID: t.TrackID})
		in.fireHook(hooks.Event{
			Name: hooks.EventTrackClosed, Subject: t.TrackID,
			At:      time.Now().UTC(),
			Payload: map[string]any{"track_id": t.TrackID, "confidence": t.Confidence},
		})
		return
	}
	if err := in.Store.UpsertTrack(ctx, t); err != nil {
		slog.Error("storing track failed", "track_id", t.TrackID, "err", err)
	}
	in.Registry.NoteFusionMessage(time.Now().UTC())

	redacted := t.Redact(in.ExposeOperatorLocation)
	in.Hub.Broadcast(hub.Frame{Type: hub.TypeTrackUpdate, Track: &redacted})

	// CONFIRMED only. Firing on every update would make the cooldown the only
	// thing standing between one aircraft and a thousand alerts, and a rule
	// whose cooldown was lowered would then flood.
	if t.State == "CONFIRMED" {
		payload := map[string]any{
			"track_id":        redacted.TrackID,
			"confidence":      redacted.Confidence,
			"detection_count": redacted.DetectionCount,
			"first_seen":      redacted.FirstSeen,
			"last_seen":       redacted.LastSeen,
			"adsb_correlated": redacted.ADSBCorrelated,
		}
		if redacted.Identity.Serial != "" {
			payload["serial"] = redacted.Identity.Serial
		}
		if redacted.Identity.Vendor != "" {
			payload["vendor"] = redacted.Identity.Vendor
		}
		// From `redacted`, never from `t`: the operator's ground position must
		// not reach a webhook by a door the websocket has closed.
		if redacted.Current != nil {
			payload["lat"] = redacted.Current.Lat
			payload["lon"] = redacted.Current.Lon
		}
		if redacted.Operator != nil {
			payload["operator_lat"] = redacted.Operator.Lat
			payload["operator_lon"] = redacted.Operator.Lon
		}
		in.fireHook(hooks.Event{
			Name: hooks.EventTrackConfirmed, Subject: t.TrackID,
			At:         time.Now().UTC(),
			Payload:    payload,
			Confidence: t.Confidence,
			IsDrone:    isDrone(t),
		})
	}
}

// Detection handles one message from a sensor's detection topic.
func (in *Ingestor) Detection(ctx context.Context, topic string, body []byte) {
	if !in.recording() {
		// Counted rather than silently dropped: a paused system must not look
		// identical to a quiet sky.
		in.Monitoring.NoteDiscarded()
		return
	}
	d, err := model.DecodeDetection(body)
	if err != nil {
		slog.Warn("dropping malformed detection from the bus", "topic", topic, "err", err)
		return
	}
	if d.DetectionID == "" {
		// Sensors are supposed to mint a ULID. Without one there is no primary
		// key and no way to deduplicate a replay, so dropping is safer than
		// inventing an id that would make the same detection countable twice.
		slog.Warn("dropping detection with no detection_id", "sensor_id", d.SensorID)
		return
	}
	if err := in.Store.InsertDetection(ctx, d); err != nil {
		slog.Error("storing detection failed", "detection_id", d.DetectionID, "err", err)
	}
	redacted := d.Redact(in.ExposeOperatorLocation)
	in.Hub.Broadcast(hub.Frame{Type: hub.TypeDetection, Detection: &redacted})

	// Subject is the identity, not the detection id: keying the cooldown on a
	// per-message id would defeat it entirely, since every detection has a new
	// one. Serial where there is one, MAC otherwise, sensor as a last resort.
	subject := redacted.Identity.Serial
	if subject == "" {
		subject = redacted.Identity.MAC
	}
	if subject == "" {
		subject = redacted.SensorID
	}
	payload := map[string]any{
		"detection_id":    redacted.DetectionID,
		"detection_class": redacted.DetectionClass,
		"sensor_id":       redacted.SensorID,
		"sensor_kind":     redacted.SensorKind,
	}
	if redacted.Identity.Serial != "" {
		payload["serial"] = redacted.Identity.Serial
	}
	if redacted.Position != nil {
		payload["lat"] = redacted.Position.Lat
		payload["lon"] = redacted.Position.Lon
	}
	in.fireHook(hooks.Event{
		Name: hooks.EventDetection, Subject: subject,
		At:         time.Now().UTC(),
		Payload:    payload,
		Class:      redacted.DetectionClass,
		SensorKind: redacted.SensorKind,
		// Class D is ADS-B: an aircraft squawking its identity, not a drone.
		IsDrone: redacted.DetectionClass != "D",
	})
}

// heartbeatMessage is the shape classg_wifi/bus.py publishes.
type heartbeatMessage struct {
	SensorID   string         `json:"sensor_id"`
	SensorKind string         `json:"sensor_kind"`
	Healthy    bool           `json:"healthy"`
	TS         model.FlexTime `json:"ts"`
	Detail     map[string]any `json:"detail"`
}

// Heartbeat handles one message from a sensor's heartbeat topic.
func (in *Ingestor) Heartbeat(ctx context.Context, topic string, body []byte) {
	var hb heartbeatMessage
	if err := json.Unmarshal(body, &hb); err != nil {
		slog.Warn("dropping malformed heartbeat from the bus", "topic", topic, "err", err)
		return
	}
	if hb.SensorID == "" {
		return
	}
	if hb.SensorKind == "" {
		// The topic is heartbeat.<kind>; fall back to it when the payload
		// omits the field.
		if _, kind, ok := strings.Cut(topic, "."); ok {
			hb.SensorKind = kind
		}
	}
	ts := hb.TS.Time
	if ts.IsZero() {
		ts = time.Now().UTC()
	}

	in.Registry.Heartbeat(health.Heartbeat{
		SensorID:   hb.SensorID,
		SensorKind: hb.SensorKind,
		Healthy:    hb.Healthy,
		TS:         ts,
		// Stamped here rather than derived from ts: this is the moment the
		// heartbeat arrived, on our clock, and it is what liveness is measured
		// against. A sensor whose clock runs ahead used to stamp heartbeats in
		// the future and stay "fresh" long after it died.
		At:     time.Now(),
		Detail: hb.Detail,
	})

	// Only on the transition, never on every heartbeat. A sensor that is down
	// sends an unhealthy heartbeat every ten seconds, and alerting on each
	// would be six alerts a minute for one fault -- which the cooldown would
	// mask rather than fix, and would mask the recovery too.
	if prev, known := in.sensorHealth(hb.SensorID); !known || prev != hb.Healthy {
		name := hooks.EventSensorUnhealthy
		if hb.Healthy {
			name = hooks.EventSensorRecovered
		}
		// The first heartbeat from a healthy sensor is not a "recovery"; it is
		// a sensor starting up, and alerting on it would mean an alert every
		// restart.
		if known || !hb.Healthy {
			payload := map[string]any{
				"sensor_id":   hb.SensorID,
				"sensor_kind": hb.SensorKind,
				"healthy":     hb.Healthy,
			}
			if reason, ok := hb.Detail["error"]; ok {
				payload["reason"] = reason
			}
			in.fireHook(hooks.Event{
				Name: name, Subject: hb.SensorID,
				At:         time.Now().UTC(),
				Payload:    payload,
				SensorKind: hb.SensorKind,
			})
		}
		in.noteSensorHealth(hb.SensorID, hb.Healthy)
	}

	// Persist so that a sensor known before an api restart is still reported
	// afterwards -- as stale, which is the truth, rather than vanishing.
	if err := in.Store.UpsertSensor(ctx, store.SensorRecord{
		SensorID:      hb.SensorID,
		SensorKind:    hb.SensorKind,
		LastHeartbeat: ts,
		Healthy:       hb.Healthy,
		Detail:        hb.Detail,
	}); err != nil {
		slog.Error("storing sensor heartbeat failed", "sensor_id", hb.SensorID, "err", err)
	}
}

// sensorHealth reads the last known health for a sensor.
//
// Kept in the Ingestor rather than read back from the store on every heartbeat:
// this is called several times a second across every sensor, and it exists only
// to spot a transition.
func (in *Ingestor) sensorHealth(id string) (healthy bool, known bool) {
	in.healthMu.Lock()
	defer in.healthMu.Unlock()
	h, ok := in.lastHealth[id]
	return h, ok
}

func (in *Ingestor) noteSensorHealth(id string, healthy bool) {
	in.healthMu.Lock()
	defer in.healthMu.Unlock()
	if in.lastHealth == nil {
		in.lastHealth = map[string]bool{}
	}
	in.lastHealth[id] = healthy
}

// HealthBroadcaster pushes health frames when the report changes.
//
// Polling and diffing rather than emitting on every heartbeat: the interesting
// transitions are time-driven (a sensor goes stale because nothing arrived),
// so an event-driven push would miss exactly the case that matters most.
type HealthBroadcaster struct {
	Hub      *hub.Hub
	Snapshot func(context.Context) health.Report
	Interval time.Duration
}

func (b *HealthBroadcaster) Run(ctx context.Context) {
	interval := b.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()

	var last string
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			rep := b.Snapshot(ctx)
			encoded, err := json.Marshal(rep)
			if err != nil {
				continue
			}
			if string(encoded) == last {
				continue
			}
			last = string(encoded)
			r := rep
			b.Hub.Broadcast(hub.Frame{Type: hub.TypeHealth, Health: &r})
		}
	}
}

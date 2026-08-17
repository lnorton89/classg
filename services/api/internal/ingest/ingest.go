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
	"time"

	"github.com/classg/api/internal/health"
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
	MaxHistory int
	// ExposeOperatorLocation gates whether operator positions reach clients.
	ExposeOperatorLocation bool
	// Monitoring is the always-on recording switch. When paused, detections
	// and tracks are discarded at this boundary rather than stopping the
	// radio -- see internal/monitoring for why.
	Monitoring *monitoring.Switch
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
		return
	}
	if err := in.Store.UpsertTrack(ctx, t); err != nil {
		slog.Error("storing track failed", "track_id", t.TrackID, "err", err)
	}
	in.Registry.NoteFusionMessage(time.Now().UTC())

	redacted := t.Redact(in.ExposeOperatorLocation)
	in.Hub.Broadcast(hub.Frame{Type: hub.TypeTrackUpdate, Track: &redacted})
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

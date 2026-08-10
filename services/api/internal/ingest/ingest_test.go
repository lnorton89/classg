package ingest

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/memstore"
)

func newIngestor(expose bool) (*Ingestor, *memstore.Store, *health.Registry, *hub.Hub) {
	st := memstore.New()
	reg := health.NewRegistry(30 * time.Second)
	h := hub.New()
	return &Ingestor{
		Store: st, Registry: reg, Hub: h,
		MaxHistory: 4, ExposeOperatorLocation: expose,
	}, st, reg, h
}

// TestTrackIngest covers what arrives on fusion's topic and what leaves on the
// stream, including the bounded history.
func TestTrackIngest(t *testing.T) {
	in, st, reg, h := newIngestor(true)
	c := h.Register([]string{hub.TopicTracks})

	body := `{"schema_version":"1.0","track_id":"T1","state":"CONFIRMED",
		"first_seen":"2026-08-10T14:00:00Z","last_seen":"2026-08-10T14:05:00Z",
		"detection_count":9,"confidence":0.82,
		"history":[{"lat":1,"lon":1},{"lat":2,"lon":2},{"lat":3,"lon":3},
		           {"lat":4,"lon":4},{"lat":5,"lon":5},{"lat":6,"lon":6}]}`
	in.Track(context.Background(), "track.update", []byte(body))

	stored, err := st.GetTrack(context.Background(), "T1")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.History) != 4 {
		t.Fatalf("history should be trimmed to MaxHistory: got %d", len(stored.History))
	}
	if stored.History[0].Lat != 3 {
		t.Fatalf("trimming should keep the newest positions: %+v", stored.History)
	}

	select {
	case f := <-c.Frames:
		if f.Type != hub.TypeTrackUpdate || f.Track == nil || f.Track.TrackID != "T1" {
			t.Fatalf("frame: %+v", f)
		}
	default:
		t.Fatal("no frame broadcast")
	}

	// Receiving anything from fusion proves the link is alive.
	rep := reg.Snapshot(time.Now(), time.Minute, "0.1.0", nil)
	if !rep.Fusion.Connected {
		t.Fatal("a track message should mark the fusion link connected")
	}
}

func TestTrackClosed(t *testing.T) {
	in, _, _, h := newIngestor(true)
	c := h.Register([]string{hub.TopicTracks})

	in.Track(context.Background(), "track.closed", []byte(`{"track_id":"T1"}`))

	f := <-c.Frames
	if f.Type != hub.TypeTrackClosed || f.TrackID != "T1" {
		t.Fatalf("frame: %+v", f)
	}
	if f.Track != nil {
		t.Fatal("a closed frame carries only the id")
	}
}

// TestMalformedBusMessagesAreDropped: a sensor or fusion build that publishes
// nonsense must not be able to take the api down. It is a separate process
// that may be mid-upgrade (ADR-0003).
func TestMalformedBusMessagesAreDropped(t *testing.T) {
	in, st, _, _ := newIngestor(true)
	ctx := context.Background()

	tests := []struct {
		name  string
		topic string
		body  string
	}{
		{"track: not json", "track.update", `}{`},
		{"track: no id", "track.update", `{"state":"CONFIRMED"}`},
		{"track: bad state", "track.update", `{"track_id":"T1","state":"AIRBORNE"}`},
		{"detection: not json", "detection.A", `}{`},
		{"detection: bad class", "detection.A", `{"detection_id":"D1","sensor_id":"wifi-0","detection_class":"Z"}`},
		{"detection: no id", "detection.A", `{"sensor_id":"wifi-0","detection_class":"A"}`},
		{"heartbeat: not json", "heartbeat.wifi", `}{`},
		{"heartbeat: no sensor", "heartbeat.wifi", `{"healthy":true}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			switch {
			case tc.topic == "track.update":
				in.Track(ctx, tc.topic, []byte(tc.body))
			case tc.topic == "detection.A":
				in.Detection(ctx, tc.topic, []byte(tc.body))
			default:
				in.Heartbeat(ctx, tc.topic, []byte(tc.body))
			}
		})
	}

	tracks, _ := st.ListTracks(ctx, store.TrackQuery{})
	if len(tracks.Tracks) != 0 {
		t.Fatalf("malformed tracks were stored: %+v", tracks.Tracks)
	}
	dets, _ := st.ListDetections(ctx, store.DetectionQuery{})
	if len(dets.Detections) != 0 {
		t.Fatalf("malformed detections were stored: %+v", dets.Detections)
	}
}

// TestHeartbeatIngest covers the shape classg_wifi/bus.py actually publishes,
// including the float epoch timestamp and the nested reason.
func TestHeartbeatIngest(t *testing.T) {
	in, st, reg, _ := newIngestor(true)
	ctx := context.Background()

	body := `{"schema_version":"1.0","ts":1786026191.482,"sensor_id":"wifi-0",
		"sensor_kind":"wifi","healthy":false,"published":0,"dropped":0,
		"detail":{"reason":"capture loop not implemented","frames_seen":0}}`
	in.Heartbeat(ctx, "heartbeat.wifi", []byte(body))

	rep := reg.Snapshot(time.Unix(1786026191, 0).UTC(), time.Minute, "0.1.0", nil)
	if len(rep.Sensors) != 1 {
		t.Fatalf("sensors: %+v", rep.Sensors)
	}
	s := rep.Sensors[0]
	if s.SensorID != "wifi-0" || s.SensorKind != "wifi" || s.Healthy {
		t.Fatalf("sensor: %+v", s)
	}
	if s.Reason != "capture loop not implemented" {
		t.Fatalf("reason: %q", s.Reason)
	}

	// Persisted, so an api restart does not make the sensor disappear.
	known, err := st.ListSensors(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(known) != 1 || known[0].SensorID != "wifi-0" {
		t.Fatalf("sensor not persisted: %+v", known)
	}
}

// TestHeartbeatKindFallsBackToTopic: the topic is heartbeat.<kind>, so a
// payload that omits sensor_kind is still classifiable.
func TestHeartbeatKindFallsBackToTopic(t *testing.T) {
	in, _, reg, _ := newIngestor(true)
	in.Heartbeat(context.Background(), "heartbeat.sdr",
		[]byte(`{"sensor_id":"sdr-0","healthy":true,"ts":"2026-08-10T14:00:00Z"}`))

	rep := reg.Snapshot(time.Date(2026, 8, 10, 14, 0, 5, 0, time.UTC), time.Minute, "0.1.0", nil)
	if rep.Sensors[0].SensorKind != "sdr" {
		t.Fatalf("kind: %q", rep.Sensors[0].SensorKind)
	}
}

// TestStreamRedactionFollowsConfig: the stream honours the same setting as the
// REST responses, in both directions.
func TestStreamRedactionFollowsConfig(t *testing.T) {
	for _, expose := range []bool{true, false} {
		in, _, _, h := newIngestor(expose)
		c := h.Register([]string{hub.TopicTracks, hub.TopicDetections})

		in.Track(context.Background(), "track.update", []byte(
			`{"track_id":"T1","state":"CONFIRMED","operator":{"lat":47.375,"lon":8.54}}`))
		f := <-c.Frames
		if (f.Track.Operator != nil) != expose {
			t.Fatalf("expose=%v: track operator present=%v", expose, f.Track.Operator != nil)
		}

		in.Detection(context.Background(), "detection.A", []byte(
			`{"detection_id":"D1","sensor_id":"wifi-0","sensor_kind":"wifi","detection_class":"A",
			  "ts":"2026-08-10T14:00:00Z","operator":{"lat":47.375,"lon":8.54}}`))
		f = <-c.Frames
		if (f.Detection.Operator != nil) != expose {
			t.Fatalf("expose=%v: detection operator present=%v", expose, f.Detection.Operator != nil)
		}
	}
}

func TestRetentionSweep(t *testing.T) {
	st := memstore.New()
	ctx := context.Background()
	now := time.Date(2026, 8, 10, 14, 0, 0, 0, time.UTC)

	in := &Ingestor{Store: st, Registry: health.NewRegistry(time.Minute), Hub: hub.New()}
	old := `{"detection_id":"OLD","sensor_id":"wifi-0","sensor_kind":"wifi","detection_class":"A","ts":"2026-08-01T00:00:00Z"}`
	fresh := `{"detection_id":"NEW","sensor_id":"wifi-0","sensor_kind":"wifi","detection_class":"A","ts":"2026-08-10T13:00:00Z"}`
	in.Detection(ctx, "detection.A", []byte(old))
	in.Detection(ctx, "detection.A", []byte(fresh))

	r := &Retention{Store: st, Detections: 7 * 24 * time.Hour, Tracks: 90 * 24 * time.Hour}
	r.Sweep(ctx, now)

	page, err := st.ListDetections(ctx, store.DetectionQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Detections) != 1 || page.Detections[0].DetectionID != "NEW" {
		t.Fatalf("retention: %+v", page.Detections)
	}
}

// TestHealthBroadcasterOnlyEmitsOnChange: a health frame every five seconds
// regardless of change would be pure noise on a link that also carries tracks.
func TestHealthBroadcasterOnlyEmitsOnChange(t *testing.T) {
	h := hub.New()
	reg := health.NewRegistry(30 * time.Second)
	reg.Heartbeat(health.Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: time.Now()})

	frozen := reg.Snapshot(time.Now(), time.Minute, "0.1.0", nil)
	b := &HealthBroadcaster{
		Hub:      h,
		Interval: 5 * time.Millisecond,
		Snapshot: func(context.Context) health.Report { return frozen },
	}
	c := h.Register([]string{hub.TopicHealth})

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	b.Run(ctx)

	if got := len(c.Frames); got != 1 {
		t.Fatalf("an unchanging report should broadcast once, got %d frames", got)
	}
	f := <-c.Frames
	if f.Type != hub.TypeHealth || f.Health == nil {
		t.Fatalf("frame: %+v", f)
	}
	if _, err := json.Marshal(f); err != nil {
		t.Fatal(err)
	}
}

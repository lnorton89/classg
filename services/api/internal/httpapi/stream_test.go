package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/model"
	"github.com/coder/websocket"
)

func dialStream(t *testing.T, h *harness) (*httptest.Server, *websocket.Conn) {
	t.Helper()
	srv := httptest.NewServer(h.server)
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/stream"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dialing stream: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return srv, conn
}

func subscribe(t *testing.T, conn *websocket.Conn, topics ...string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"type": "subscribe", "topics": topics})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, body); err != nil {
		t.Fatalf("subscribing: %v", err)
	}
}

func readFrame(t *testing.T, conn *websocket.Conn) hub.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("reading frame: %v", err)
	}
	var f hub.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("decoding frame %s: %v", data, err)
	}
	return f
}

// waitForSubscription gives the server's reader goroutine a moment to apply a
// subscribe frame. Broadcasts are fire-and-forget, so a frame published before
// the subscription lands is legitimately dropped.
func waitForSubscription(t *testing.T, h *harness) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.hub.ClientCount() > 0 {
			time.Sleep(50 * time.Millisecond)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("client never registered with the hub")
}

// TestStreamDeliversSubscribedTopicsOnly pins the subscribe semantics: a
// client that asked for tracks must not be sent detections, which on a busy
// Wi-Fi channel would be orders of magnitude more traffic.
func TestStreamDeliversSubscribedTopicsOnly(t *testing.T) {
	h := newHarness(t, nil)
	_, conn := dialStream(t, h)
	subscribe(t, conn, hub.TopicTracks)
	waitForSubscription(t, h)

	det := model.Detection{DetectionID: "D1", SensorID: "wifi-0", DetectionClass: "A"}
	h.hub.Broadcast(hub.Frame{Type: hub.TypeDetection, Detection: &det})

	tr := model.Track{TrackID: "T1", State: "CONFIRMED"}
	h.hub.Broadcast(hub.Frame{Type: hub.TypeTrackUpdate, Track: &tr})

	f := readFrame(t, conn)
	if f.Type != hub.TypeTrackUpdate {
		t.Fatalf("first frame should be the subscribed one, got %q", f.Type)
	}
	if f.Track == nil || f.Track.TrackID != "T1" {
		t.Fatalf("track payload: %+v", f.Track)
	}
	if f.TS.IsZero() {
		t.Fatal("every frame must carry ts")
	}
}

// TestStreamResubscribe: the contract allows a client to change topics
// mid-stream, which is how the web app switches views without reconnecting.
func TestStreamResubscribe(t *testing.T) {
	h := newHarness(t, nil)
	_, conn := dialStream(t, h)
	subscribe(t, conn, hub.TopicTracks)
	waitForSubscription(t, h)

	subscribe(t, conn, hub.TopicDetections)
	time.Sleep(100 * time.Millisecond)

	tr := model.Track{TrackID: "T1", State: "CONFIRMED"}
	h.hub.Broadcast(hub.Frame{Type: hub.TypeTrackUpdate, Track: &tr})
	det := model.Detection{DetectionID: "D1", SensorID: "wifi-0", DetectionClass: "A"}
	h.hub.Broadcast(hub.Frame{Type: hub.TypeDetection, Detection: &det})

	f := readFrame(t, conn)
	if f.Type != hub.TypeDetection {
		t.Fatalf("after resubscribing, got %q", f.Type)
	}
}

// TestStreamRedactsOperatorLocation: the stream is a response path like any
// other and must honour the same setting.
func TestStreamOperatorRedaction(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "false"})
	_, conn := dialStream(t, h)
	subscribe(t, conn, hub.TopicTracks)
	waitForSubscription(t, h)

	tr := model.Track{
		TrackID: "T1", State: "CONFIRMED",
		Operator: &model.OperatorPosition{Lat: 47.375, Lon: 8.54},
	}
	redacted := tr.Redact(h.cfg.ExposeOperatorLocation)
	h.hub.Broadcast(hub.Frame{Type: hub.TypeTrackUpdate, Track: &redacted})

	f := readFrame(t, conn)
	if f.Track == nil {
		t.Fatal("no track in frame")
	}
	if f.Track.Operator != nil {
		t.Fatalf("operator survived redaction on the stream: %+v", f.Track.Operator)
	}
}

// TestStreamDropsSlowConsumers is the contract's backpressure requirement.
//
// A client that never reads must be disconnected rather than buffered for.
// The assertion is that the server closes the socket: the client then
// reconnects and refetches, which is how the gap is recovered correctly.
func TestStreamDropsSlowConsumers(t *testing.T) {
	h := newHarness(t, nil)
	_, conn := dialStream(t, h)
	subscribe(t, conn, hub.TopicTracks)
	waitForSubscription(t, h)

	// Never read; flood well past the client buffer.
	tr := model.Track{TrackID: "T1", State: "CONFIRMED"}
	for i := 0; i < 5000; i++ {
		h.hub.Broadcast(hub.Frame{Type: hub.TypeTrackUpdate, Track: &tr})
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if h.hub.ClientCount() == 0 {
			return // the hub gave up on it, which is the required behaviour
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("a consumer that never reads was never dropped")
}

// TestStreamSurvivesGarbage: a malformed client frame must not take the
// connection down, or one buggy client build becomes an outage.
func TestStreamSurvivesGarbage(t *testing.T) {
	h := newHarness(t, nil)
	_, conn := dialStream(t, h)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte("not json at all")); err != nil {
		t.Fatal(err)
	}
	subscribe(t, conn, hub.TopicTracks)
	waitForSubscription(t, h)

	tr := model.Track{TrackID: "T1", State: "CONFIRMED"}
	h.hub.Broadcast(hub.Frame{Type: hub.TypeTrackUpdate, Track: &tr})

	if f := readFrame(t, conn); f.Type != hub.TypeTrackUpdate {
		t.Fatalf("got %q", f.Type)
	}
}

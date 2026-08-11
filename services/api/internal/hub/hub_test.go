package hub

import (
	"testing"
	"time"
)

func TestTopicRouting(t *testing.T) {
	tests := []struct {
		frameType string
		topics    []string
		want      bool
	}{
		{TypeTrackUpdate, []string{TopicTracks}, true},
		{TypeTrackClosed, []string{TopicTracks}, true},
		{TypeDetection, []string{TopicTracks}, false},
		{TypeDetection, []string{TopicDetections}, true},
		{TypeHealth, []string{TopicHealth}, true},
		{TypeHealth, []string{TopicTracks, TopicDetections}, false},
		{TypeCaptureStatus, []string{TopicCaptures}, true},
		{TypeTrackUpdate, nil, false},
		// A ping is a control frame and reaches even a client that subscribed
		// to nothing -- the contract requires it to answer.
		{TypePing, nil, true},
	}
	for _, tc := range tests {
		t.Run(tc.frameType+"/"+join(tc.topics), func(t *testing.T) {
			h := New()
			c := h.Register(tc.topics)
			h.Broadcast(Frame{Type: tc.frameType})

			select {
			case <-c.Frames:
				if !tc.want {
					t.Fatal("frame delivered to a client that did not subscribe to it")
				}
			default:
				if tc.want {
					t.Fatal("subscribed client did not receive the frame")
				}
			}
		})
	}
}

// TestSlowConsumerIsDropped is the contract's backpressure rule. The hub must
// never grow a buffer for a client that has stopped reading.
func TestSlowConsumerIsDropped(t *testing.T) {
	h := New()
	c := h.Register([]string{TopicTracks})

	for i := 0; i < clientBuffer*4; i++ {
		h.Broadcast(Frame{Type: TypeTrackUpdate})
	}

	select {
	case <-c.Dropped:
	default:
		t.Fatal("a client that never read was not dropped")
	}
	if h.ClientCount() != 0 {
		t.Fatalf("dropped client still registered: %d", h.ClientCount())
	}
	if len(c.Frames) > clientBuffer {
		t.Fatalf("buffer grew past its bound: %d", len(c.Frames))
	}
}

// TestFastConsumerSurvivesTheSameFlood: the drop rule must not punish a client
// that is keeping up.
func TestFastConsumerSurvivesTheSameFlood(t *testing.T) {
	h := New()
	c := h.Register([]string{TopicTracks})

	done := make(chan int)
	go func() {
		n := 0
		for range c.Frames {
			n++
			if n == 500 {
				done <- n
				return
			}
		}
	}()

	for i := 0; i < 500; i++ {
		h.Broadcast(Frame{Type: TypeTrackUpdate})
		if i%50 == 0 {
			time.Sleep(time.Millisecond)
		}
	}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a client that kept up was starved or dropped")
	}
}

func TestBroadcastStampsTS(t *testing.T) {
	h := New()
	c := h.Register([]string{TopicTracks})
	h.Broadcast(Frame{Type: TypeTrackUpdate})

	f := <-c.Frames
	if f.TS.IsZero() {
		t.Fatal("every frame must carry ts")
	}
}

func TestUnregisterIsIdempotent(t *testing.T) {
	h := New()
	c := h.Register(nil)
	h.Unregister(c)
	h.Unregister(c) // must not panic on a double close
	if h.ClientCount() != 0 {
		t.Fatal("client still registered")
	}
}

func join(s []string) string {
	if len(s) == 0 {
		return "none"
	}
	out := s[0]
	for _, v := range s[1:] {
		out += "+" + v
	}
	return out
}

func TestOnFirstClientFiresOnceForAnEmptyHub(t *testing.T) {
	// Recording follows the web app being up, so this must fire exactly when
	// the app appears -- not on every tab, and not never.
	h := New()
	var calls int
	h.OnFirstClient(func() { calls++ })

	a := h.Register(nil)
	if calls != 1 {
		t.Fatalf("first client fired %d times, want 1", calls)
	}

	b := h.Register(nil)
	if calls != 1 {
		t.Fatalf("a second concurrent client fired it again (%d)", calls)
	}

	h.Unregister(a)
	h.Unregister(b)

	// Emptied and reopened: the app coming back is the app being up again.
	h.Register(nil)
	if calls != 2 {
		t.Fatalf("reconnecting to an empty hub fired %d times, want 2", calls)
	}
}

func TestOnFirstClientIsOptional(t *testing.T) {
	h := New()
	h.Register(nil) // must not panic without a callback
}

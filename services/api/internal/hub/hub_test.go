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
//
// Batched against clientBuffer with a handshake, rather than a producer that
// sleeps a millisecond every fiftieth frame and hopes the consumer was
// scheduled. That version failed on a loaded machine -- correctly, by the
// hub's own contract: it drops a client whose buffer is full, and whether a
// goroutine ran in a given millisecond is not something a test gets to assume.
// A test that reddens main under load teaches people to re-run it, which is
// how a real drop bug would get waved through.
//
// Each round fills the buffer exactly and is drained before the next begins,
// so the flood is real -- 512 frames, eight bufferfuls -- and the client
// provably never had a full buffer at a broadcast.
func TestFastConsumerSurvivesTheSameFlood(t *testing.T) {
	h := New()
	c := h.Register([]string{TopicTracks})

	const rounds = 8
	got := 0
	for r := 0; r < rounds; r++ {
		for i := 0; i < clientBuffer; i++ {
			h.Broadcast(Frame{Type: TypeTrackUpdate})
		}
		for i := 0; i < clientBuffer; i++ {
			select {
			case _, ok := <-c.Frames:
				if !ok {
					t.Fatalf("the frame channel closed after %d frames; a client that "+
						"kept up was dropped", got)
				}
				got++
			case <-c.Dropped:
				t.Fatalf("a client that kept up was dropped after %d frames", got)
			case <-time.After(5 * time.Second):
				t.Fatalf("only %d of %d frames arrived", got, rounds*clientBuffer)
			}
		}
	}

	if got != rounds*clientBuffer {
		t.Fatalf("received %d frames, want %d", got, rounds*clientBuffer)
	}
	select {
	case <-c.Dropped:
		t.Fatal("the client was dropped after keeping up with the whole flood")
	default:
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

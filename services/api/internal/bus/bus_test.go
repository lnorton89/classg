package bus

import (
	"context"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/go-zeromq/zmq4"
)

// freePort asks the OS for a port and gives it straight back, so the PUB
// socket below can bind something nothing else is using.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// A subscriber that never resets its backoff is indistinguishable from a
// working one until the day it matters. This drives the real socket rather
// than a fake, because the thing under test is the reconnect loop.
func TestSubscriberDeliversAndRecovers(t *testing.T) {
	port := freePort(t)
	endpoint := fmt.Sprintf("tcp://127.0.0.1:%d", port)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	var got []Message
	var states []State

	go Run(ctx, Options{
		Name:     "test",
		Endpoint: endpoint,
		Topics:   []string{""},
		OnMessage: func(m Message) {
			mu.Lock()
			got = append(got, m)
			mu.Unlock()
		},
		OnState: func(s State) {
			mu.Lock()
			states = append(states, s)
			mu.Unlock()
		},
	})

	publish := func(topic, body string) {
		pub := zmq4.NewPub(ctx)
		if err := pub.Listen(endpoint); err != nil {
			t.Errorf("listen: %v", err)
			return
		}
		// PUB drops anything sent before a subscriber has attached, so give the
		// subscriber a moment to dial in rather than racing it.
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			_ = pub.Send(zmq4.NewMsgFrom([]byte(topic), []byte(body)))
			mu.Lock()
			n := len(got)
			mu.Unlock()
			if n > 0 {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		pub.Close()
	}

	publish("detection.A", `{"first":true}`)

	mu.Lock()
	first := len(got)
	mu.Unlock()
	if first == 0 {
		t.Fatal("no message delivered while the publisher was up")
	}

	// The publisher is gone. The subscriber must notice and report it.
	waitFor(t, 8*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, s := range states {
			if !s.Connected {
				return true
			}
		}
		return false
	}, "the subscriber never reported itself disconnected")

	// Bring it back. With the backoff reset this reconnects in well under the
	// 30s cap; without it, a subscriber that had already climbed would sit out
	// most of this window.
	mu.Lock()
	got = nil
	mu.Unlock()
	publish("detection.A", `{"second":true}`)

	mu.Lock()
	second := len(got)
	mu.Unlock()
	if second == 0 {
		t.Fatal("the subscriber did not recover after the publisher came back")
	}
}

// An endpoint nobody is listening on must not stop the caller: ADR-0003 says a
// missing publisher is an expected state, and the api has to keep serving
// /health precisely so it can report one.
func TestUnreachableEndpointKeepsRunning(t *testing.T) {
	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	var reasons []string
	done := make(chan struct{})
	go func() {
		Run(ctx, Options{
			Name:     "test",
			Endpoint: fmt.Sprintf("tcp://127.0.0.1:%d", port),
			Topics:   []string{""},
			OnState: func(s State) {
				mu.Lock()
				if !s.Connected {
					reasons = append(reasons, s.Reason)
				}
				mu.Unlock()
			},
		})
		close(done)
	}()

	// go-zeromq retries inside Dial before returning an error, so the first
	// disconnected state takes several seconds to arrive. Wait for it rather
	// than for a fixed duration, then stop.
	waitFor(t, 20*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(reasons) > 0
	}, "a dead endpoint produced no disconnected state for /health to report")

	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	mu.Lock()
	defer mu.Unlock()
	for _, r := range reasons {
		if r == "" {
			t.Error("a disconnected state carried no reason")
		}
	}
}

// An empty endpoint is configuration, not a fault: it must return at once
// rather than retrying nothing for ever.
func TestUnconfiguredEndpointReturnsImmediately(t *testing.T) {
	var got State
	done := make(chan struct{})
	go func() {
		Run(context.Background(), Options{
			Name:    "test",
			OnState: func(s State) { got = s },
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run blocked on an unconfigured endpoint")
	}
	if got.Connected || got.Reason != "not configured" {
		t.Errorf("state was %+v, want disconnected with 'not configured'", got)
	}
}

func waitFor(t *testing.T, d time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal(msg)
}

// The reset itself. TestSubscriberDeliversAndRecovers does not cover it: the
// backoff climbs one step there, so recovery looks the same either way. This
// drives enough disconnects to reach the cap and then asserts a working
// connection puts the delay back to the floor.
func TestBackoffResetsAfterAWorkingConnection(t *testing.T) {
	port := freePort(t)
	endpoint := fmt.Sprintf("tcp://127.0.0.1:%d", port)

	var mu sync.Mutex
	var delays []time.Duration
	connected := false
	orig := afterFunc
	afterFunc = func(d time.Duration) <-chan time.Time {
		mu.Lock()
		delays = append(delays, d)
		mu.Unlock()
		// Fire immediately: what matters is the delay asked for, not waiting it.
		ch := make(chan time.Time, 1)
		ch <- time.Now()
		return ch
	}
	t.Cleanup(func() { afterFunc = orig })

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Run(ctx, Options{
			Name: "test", Endpoint: endpoint, Topics: []string{""},
			OnState: func(s State) {
				mu.Lock()
				if s.Connected {
					connected = true
				}
				mu.Unlock()
			},
		})
		close(done)
	}()

	// Nothing is listening, so every attempt fails and the delay climbs.
	waitFor(t, 90*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(delays) >= 4
	}, "the subscriber never accumulated enough retries to climb")

	mu.Lock()
	climbed := delays[len(delays)-1]
	mu.Unlock()
	if climbed <= minBackoff*2 {
		t.Fatalf("after repeated failures the delay was %v; it should have climbed past %v", climbed, minBackoff*2)
	}

	// Let it connect, then take the publisher away again. The retry that
	// follows is the one that must start from the floor.
	pub := zmq4.NewPub(ctx)
	if err := pub.Listen(endpoint); err != nil {
		t.Fatalf("listen: %v", err)
	}
	waitFor(t, 90*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return connected
	}, "the subscriber never connected once a publisher was listening")

	mu.Lock()
	mark := len(delays)
	mu.Unlock()
	pub.Close()

	waitFor(t, 90*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(delays) > mark
	}, "no retry was observed after the publisher went away again")

	mu.Lock()
	after := delays[mark]
	mu.Unlock()
	cancel()
	<-done

	// minBackoff plus up to 50% jitter.
	if after > minBackoff+minBackoff/2 {
		t.Errorf("after a working connection the delay was %v, want it reset to about %v", after, minBackoff)
	}
}

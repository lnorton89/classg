// Package bus subscribes to the ZeroMQ topics defined in ADR-0002.
//
//	sensors  PUB tcp://127.0.0.1:5556  detection.<class>, heartbeat.<kind>
//	fusion   PUB tcp://127.0.0.1:5557  track.<event>
//
// Nothing here is allowed to stop the service. Every publisher in this system
// is a separate process that may not be running (ADR-0003), and an api that
// refuses to start because fusion is down is the opposite of the degradation
// this architecture is built for -- /health can only report a broken pipeline
// if it is running to report it.
package bus

import (
	"context"
	"log/slog"
	"math/rand"
	"time"

	"github.com/go-zeromq/zmq4"
)

// Message is one multipart frame pair from the bus.
type Message struct {
	Topic string
	Body  []byte
}

// State reports the connection to one endpoint. Connected is what /health
// turns into "fusion is not talking to me".
type State struct {
	Connected bool
	Reason    string
}

type Options struct {
	Name     string // for logs: "fusion" or "sensors"
	Endpoint string
	Topics   []string
	// OnMessage is called from the subscriber goroutine. It must not block for
	// long: this loop is the only reader of the socket.
	OnMessage func(Message)
	OnState   func(State)
}

const (
	minBackoff = 500 * time.Millisecond
	maxBackoff = 30 * time.Second
)

// Swapped in tests. The reset below is three lines that only misbehave after
// several disconnects, which is exactly the shape of thing that ships broken
// and is only noticed on the unit -- so the retry delay is made observable
// rather than inferred from how long a test took.
var afterFunc = time.After

// Run subscribes until ctx is cancelled, reconnecting with capped exponential
// backoff. It returns only when ctx is done.
func Run(ctx context.Context, opts Options) {
	if opts.Endpoint == "" {
		notify(opts.OnState, State{Connected: false, Reason: "not configured"})
		return
	}
	backoff := minBackoff
	for ctx.Err() == nil {
		connected, err := runOnce(ctx, opts)
		if ctx.Err() != nil {
			return
		}
		// A connection that worked earns the short retry back. Without this the
		// backoff only ever climbs: the api starts alongside fusion, so these
		// subscribers reliably flap a few times at boot, reach the 30s cap, and
		// stay there for the life of the process. A later blip lasting
		// milliseconds then costs thirty seconds of no detections, no tracks
		// and no heartbeats -- during which /health goes stale and the map
		// empties, for a fault that had already cleared. The SDR sensor's
		// reconnect resets, and so does fusion's; this was the one that did not.
		if connected {
			backoff = minBackoff
		}
		notify(opts.OnState, State{Connected: false, Reason: reasonOf(err)})
		// Jitter so that several subscribers reconnecting after a shared
		// outage (a USB brownout takes out every sensor at once -- see
		// overview.md) do not retry in lockstep.
		sleep := backoff + time.Duration(rand.Int63n(int64(backoff/2+1)))
		slog.Warn("bus subscriber disconnected, retrying",
			"name", opts.Name, "endpoint", opts.Endpoint, "err", err, "retry_in", sleep)
		select {
		case <-ctx.Done():
			return
		case <-afterFunc(sleep):
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// runOnce reports whether it ever reached the connected state, so the caller
// can tell "the endpoint is down" from "the endpoint was up and dropped".
func runOnce(ctx context.Context, opts Options) (bool, error) {
	sock := zmq4.NewSub(ctx)
	defer sock.Close()

	if err := sock.Dial(opts.Endpoint); err != nil {
		return false, err
	}
	for _, t := range opts.Topics {
		if err := sock.SetOption(zmq4.OptionSubscribe, t); err != nil {
			return false, err
		}
	}

	slog.Info("bus subscriber connected", "name", opts.Name, "endpoint", opts.Endpoint, "topics", opts.Topics)
	notify(opts.OnState, State{Connected: true})

	for {
		msg, err := sock.Recv()
		if err != nil {
			return true, err
		}
		// PUB/SUB here is two-frame: [topic][json]. A single-frame message is
		// a publisher bug rather than something to crash over.
		switch len(msg.Frames) {
		case 0:
			continue
		case 1:
			opts.OnMessage(Message{Topic: "", Body: msg.Frames[0]})
		default:
			opts.OnMessage(Message{Topic: string(msg.Frames[0]), Body: msg.Frames[1]})
		}
	}
}

func notify(fn func(State), s State) {
	if fn != nil {
		fn(s)
	}
}

func reasonOf(err error) string {
	if err == nil {
		return "disconnected"
	}
	return err.Error()
}

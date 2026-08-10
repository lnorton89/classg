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

// Run subscribes until ctx is cancelled, reconnecting with capped exponential
// backoff. It returns only when ctx is done.
func Run(ctx context.Context, opts Options) {
	if opts.Endpoint == "" {
		notify(opts.OnState, State{Connected: false, Reason: "not configured"})
		return
	}
	backoff := minBackoff
	for ctx.Err() == nil {
		err := runOnce(ctx, opts)
		if ctx.Err() != nil {
			return
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
		case <-time.After(sleep):
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

func runOnce(ctx context.Context, opts Options) error {
	sock := zmq4.NewSub(ctx)
	defer sock.Close()

	if err := sock.Dial(opts.Endpoint); err != nil {
		return err
	}
	for _, t := range opts.Topics {
		if err := sock.SetOption(zmq4.OptionSubscribe, t); err != nil {
			return err
		}
	}

	slog.Info("bus subscriber connected", "name", opts.Name, "endpoint", opts.Endpoint, "topics", opts.Topics)
	notify(opts.OnState, State{Connected: true})

	for {
		msg, err := sock.Recv()
		if err != nil {
			return err
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

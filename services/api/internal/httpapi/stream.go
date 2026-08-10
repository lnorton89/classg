package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/classg/api/internal/hub"
	"github.com/coder/websocket"
)

// pingInterval is fixed by the contract: "Server sends {"type":"ping"} every
// 30 s; clients reply {"type":"pong"}".
const pingInterval = 30 * time.Second

// writeTimeout bounds a single frame write. A consumer that cannot absorb one
// frame in this long is wedged, and the contract says to drop it rather than
// buffer for it.
const writeTimeout = 10 * time.Second

// clientMessage is what a client may send.
type clientMessage struct {
	Type   string   `json:"type"`
	Topics []string `json:"topics"`
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// v1 has no authentication and is documented as localhost/trusted-LAN
		// only (api-contract.md#auth). An origin allowlist here would imply a
		// security boundary that does not exist, and would break the CLI,
		// which sends no Origin at all.
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		// Accept has already written a response.
		return
	}
	defer conn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Subscribe to nothing until told otherwise, so a client that never sends
	// a subscribe frame costs nothing.
	client := s.hub.Register(nil)
	defer s.hub.Unregister(client)

	// Reader goroutine: subscribe frames, pongs, and connection close.
	go func() {
		defer cancel()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var msg clientMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				continue // a malformed frame is not worth dropping a client for
			}
			switch msg.Type {
			case "subscribe":
				client.SetTopics(msg.Topics)
			case hub.TypePong:
				// The contract requires the client to answer pings. Nothing
				// needs doing with the answer: a client that stops answering
				// fails on the next write instead.
			}
		}
	}()

	ping := time.NewTicker(pingInterval)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case <-client.Dropped:
			// The hub gave up on this client because it fell too far behind.
			// Closing with a policy-violation code tells the client this was
			// deliberate; it reconnects and refetches, which recovers the gap.
			_ = conn.Close(websocket.StatusPolicyViolation, "consumer too slow")
			return

		case f := <-client.Frames:
			if err := writeFrame(ctx, conn, f); err != nil {
				return
			}

		case <-ping.C:
			if err := writeFrame(ctx, conn, hub.Frame{Type: hub.TypePing, TS: time.Now().UTC()}); err != nil {
				return
			}
		}
	}
}

func writeFrame(ctx context.Context, conn *websocket.Conn, f hub.Frame) error {
	if f.TS.IsZero() {
		f.TS = time.Now().UTC()
	}
	body, err := json.Marshal(f)
	if err != nil {
		slog.Error("encoding stream frame failed", "type", f.Type, "err", err)
		return nil // one bad frame must not kill the connection
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	if err := conn.Write(writeCtx, websocket.MessageText, body); err != nil {
		if !errors.Is(err, context.Canceled) {
			slog.Debug("stream write failed, closing", "err", err)
		}
		return err
	}
	return nil
}

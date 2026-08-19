package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/classg/api/internal/hub"
	"github.com/coder/websocket"
)

func hasSessionCookie(r *http.Request) bool {
	_, err := r.Cookie(SessionCookie)
	return err == nil
}

// streamOriginAllowed accepts the request's own host and any localhost
// origin. See handleStream for why localhost gets a pass.
func streamOriginAllowed(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(u.Host, host) {
		return true
	}
	switch strings.ToLower(u.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

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
	// When a session cookie authenticated this handshake, a cross-site page
	// must not be able to ride it: a browser sends the cookie automatically,
	// and before this check the only thing stopping evil.example from opening
	// an authenticated stream was SameSite=Lax -- an accident of the cookie
	// settings, not a designed boundary. The CLI is unaffected (it sends no
	// Origin at all, like every non-browser client), and so is the served app
	// (same origin by definition). Localhost origins are allowed through for
	// the Vite dev server, whose proxy rewrites Host (changeOrigin) so a
	// strict equality check would break `make dev` -- pages on the operator's
	// own machine are outside the cross-site threat this guards against.
	if origin := r.Header.Get("Origin"); origin != "" && hasSessionCookie(r) && !streamOriginAllowed(origin, r.Host) {
		http.Error(w, "cross-origin WebSocket with a session cookie is refused", http.StatusForbidden)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The cookie-authenticated case was already vetted above; everything
		// else (no cookie, or no Origin) keeps the open pattern so the CLI
		// and token-less trusted-LAN deployments keep working.
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

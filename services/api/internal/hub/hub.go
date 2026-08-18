// Package hub fans server frames out to WebSocket subscribers.
//
// The contract's requirement -- "server drops slow consumers rather than
// buffering without bound" -- is the whole design constraint. A browser tab on
// a wedged laptop must not be able to grow the api's heap until the Pi starts
// swapping and the capture loop misses beacons.
package hub

import (
	"sync"
	"time"

	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/monitoring"
)

// Topic names from the contract's subscribe message.
const (
	TopicTracks     = "tracks"
	TopicDetections = "detections"
	TopicHealth     = "health"
	TopicCaptures   = "captures"
	// Sweeps get their own topic rather than riding captures. Both are
	// operator-initiated measurements, but a client that wants one does not
	// necessarily want the other, and a sweep document is large.
	TopicSpectrum = "spectrum"
)

// Frame types from the contract.
const (
	TypeTrackUpdate   = "track.update"
	TypeTrackClosed   = "track.closed"
	TypeDetection     = "detection"
	TypeHealth        = "health"
	TypeCaptureStatus = "capture.status"
	TypeSweepStatus   = "sweep.status"
	TypeMonitoring    = "monitoring"
	TypePing          = "ping"
	TypePong          = "pong"
)

// Frame is a server-to-client message. Every frame carries type and ts; the
// rest is set according to type.
type Frame struct {
	Type      string           `json:"type"`
	TS        time.Time        `json:"ts"`
	Track     *model.Track     `json:"track,omitempty"`
	TrackID   string           `json:"track_id,omitempty"`
	Detection *model.Detection `json:"detection,omitempty"`
	Health    *health.Report   `json:"health,omitempty"`
	Capture   *model.Capture   `json:"capture,omitempty"`
	// Sweep carries the RECORD, never the bins. A completed fpv_1g2 sweep is
	// well over a megabyte of measurement, and pushing that to every open
	// browser to say "it finished" would cost more than the sweep did. The
	// client refetches the detail it wants.
	Sweep      *model.SpectrumSweep `json:"sweep,omitempty"`
	Monitoring *monitoring.State    `json:"monitoring,omitempty"`
}

// TopicFor maps a frame type to the topic a client must have subscribed to.
func TopicFor(frameType string) string {
	switch frameType {
	case TypeTrackUpdate, TypeTrackClosed:
		return TopicTracks
	case TypeDetection:
		return TopicDetections
	case TypeHealth:
		return TopicHealth
	case TypeCaptureStatus:
		return TopicCaptures
	case TypeSweepStatus:
		return TopicSpectrum
	case TypeMonitoring:
		// Rides the health topic rather than needing its own subscription:
		// whether the system is recording is part of whether it is working,
		// and a client that cares about one always cares about the other.
		return TopicHealth
	}
	return ""
}

// clientBuffer is deliberately small. It absorbs a scheduling hiccup, not a
// consumer that has stopped reading: a client that falls this far behind is
// already showing stale data, and the contract tells it to reconnect and
// refetch rather than to expect the server to have kept its place.
const clientBuffer = 64

type Client struct {
	Frames chan Frame
	// Dropped is closed when the hub gives up on this client. The connection
	// handler watches it and closes the socket, which makes the client
	// reconnect and refetch -- recovering the gap correctly.
	Dropped chan struct{}

	mu     sync.Mutex
	topics map[string]bool
	closed bool
}

// SetTopics replaces the subscription set. Clients may resubscribe mid-stream.
func (c *Client) SetTopics(topics []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.topics = map[string]bool{}
	for _, t := range topics {
		c.topics[t] = true
	}
}

func (c *Client) wants(frameType string) bool {
	// Control frames are never filtered: a client that subscribed to nothing
	// still has to answer pings.
	if frameType == TypePing {
		return true
	}
	topic := TopicFor(frameType)
	if topic == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.topics[topic]
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}
}

func New() *Hub { return &Hub{clients: map[*Client]struct{}{}} }

// Register subscribes a client. Note that connecting has no effect on whether
// the system is recording: recording follows the stack being up, not anyone
// watching. Nobody needs to have the app open for a flight to be captured.
func (h *Hub) Register(topics []string) *Client {
	c := &Client{
		Frames:  make(chan Frame, clientBuffer),
		Dropped: make(chan struct{}),
	}
	c.SetTopics(topics)
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	return c
}

func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		h.mu.Unlock()
		c.close()
		return
	}
	h.mu.Unlock()
}

func (c *Client) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.Dropped)
}

// Broadcast delivers f to every interested client, never blocking. A client
// whose buffer is full is dropped, not waited for.
func (h *Hub) Broadcast(f Frame) {
	if f.TS.IsZero() {
		f.TS = time.Now().UTC()
	}
	h.mu.RLock()
	targets := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	var slow []*Client
	for _, c := range targets {
		if !c.wants(f.Type) {
			continue
		}
		select {
		case c.Frames <- f:
		default:
			slow = append(slow, c)
		}
	}
	for _, c := range slow {
		h.Unregister(c)
	}
}

func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

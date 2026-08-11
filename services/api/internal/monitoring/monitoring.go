// Package monitoring holds the always-on recording switch.
//
// ClassG records continuously by default: a detector you have to remember to
// arm is a detector that is off when it matters. Opening the web app does not
// start recording, and closing it does not stop it -- the sensor keeps running
// either way, and the UI reports what is already happening rather than driving
// it. Tying the radio to a browser tab would mean a closed laptop is an
// undetected sky.
//
// What the UI CAN do is pause recording deliberately, which is a different and
// legitimate thing: testing, a known local flight, or simply not wanting the
// next hour on record.
//
// Pausing gates INGESTION, not the radio. The sensor is a separate process
// under its own supervisor (ADR-0003), frequently on a different machine from
// the API -- in the container stack the API cannot signal the WSL sensor at
// all. Discarding detections at the ingest boundary is the one mechanism that
// works everywhere, and it means resuming is instant rather than waiting for a
// radio to come back and re-acquire.
package monitoring

import (
	"sync"
	"time"
)

// State is the recording switch plus enough context to explain itself.
type State struct {
	Enabled bool      `json:"enabled"`
	Since   time.Time `json:"since"`
	// Reason is operator-supplied when pausing, so the UI can say why the sky
	// is not being watched rather than just that it is not.
	Reason string `json:"reason,omitempty"`
	// Discarded counts detections dropped while paused. Without it a paused
	// system looks identical to a quiet one, which is the failure ADR-0003 is
	// written against.
	Discarded int64 `json:"discarded_while_paused"`
}

// Switch is safe for concurrent use: the bus goroutines read it per detection
// while HTTP handlers write it.
type Switch struct {
	mu        sync.RWMutex
	enabled   bool
	since     time.Time
	reason    string
	discarded int64
	onChange  func(State)
}

// New returns a Switch. Recording starts enabled -- see the package comment.
func New(enabled bool, now time.Time) *Switch {
	return &Switch{enabled: enabled, since: now}
}

// OnChange registers a callback fired after every state change, used to push
// the new state to connected clients.
func (s *Switch) OnChange(fn func(State)) {
	s.mu.Lock()
	s.onChange = fn
	s.mu.Unlock()
}

// Enabled is the hot path: called once per detection.
func (s *Switch) Enabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.enabled
}

// Set changes the switch. Setting it to its current value is a no-op, so a
// repeated PUT does not reset `since` or re-broadcast.
func (s *Switch) Set(enabled bool, reason string, now time.Time) State {
	s.mu.Lock()
	changed := s.enabled != enabled
	if changed {
		s.enabled = enabled
		s.since = now
		s.reason = reason
		if enabled {
			// A fresh pause should not inherit the previous one's tally.
			s.discarded = 0
		}
	}
	state := s.stateLocked()
	fn := s.onChange
	s.mu.Unlock()

	if changed && fn != nil {
		fn(state)
	}
	return state
}

// NoteDiscarded records a detection dropped because recording is paused.
func (s *Switch) NoteDiscarded() {
	s.mu.Lock()
	s.discarded++
	s.mu.Unlock()
}

func (s *Switch) State() State {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.stateLocked()
}

func (s *Switch) stateLocked() State {
	return State{
		Enabled:   s.enabled,
		Since:     s.since,
		Reason:    s.reason,
		Discarded: s.discarded,
	}
}

package monitoring

import (
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 8, 11, 4, 0, 0, 0, time.UTC)

func TestRecordingIsOnByDefault(t *testing.T) {
	// A detector you have to remember to arm is a detector that is off when it
	// matters. Nothing about opening a browser should be required to record.
	if !New(true, t0).Enabled() {
		t.Fatal("recording must start enabled")
	}
}

func TestPauseAndResume(t *testing.T) {
	s := New(true, t0)

	paused := s.Set(false, "testing indoors", t0.Add(time.Minute))
	if paused.Enabled {
		t.Fatal("should be paused")
	}
	if paused.Reason != "testing indoors" {
		t.Fatalf("reason = %q; the UI has to be able to say WHY the sky is unwatched", paused.Reason)
	}
	if !paused.Since.Equal(t0.Add(time.Minute)) {
		t.Fatalf("since = %s", paused.Since)
	}
	if s.Enabled() {
		t.Fatal("Enabled() disagrees with the returned state")
	}

	resumed := s.Set(true, "", t0.Add(2*time.Minute))
	if !resumed.Enabled {
		t.Fatal("should be recording again")
	}
}

func TestDiscardedCountIsVisible(t *testing.T) {
	// A paused system must not look identical to a quiet one.
	s := New(true, t0)
	s.Set(false, "", t0)
	for i := 0; i < 3; i++ {
		s.NoteDiscarded()
	}
	if got := s.State().Discarded; got != 3 {
		t.Fatalf("discarded = %d, want 3", got)
	}
}

func TestResumingClearsTheDiscardCount(t *testing.T) {
	s := New(true, t0)
	s.Set(false, "", t0)
	s.NoteDiscarded()
	s.Set(true, "", t0.Add(time.Minute))
	if got := s.State().Discarded; got != 0 {
		t.Fatalf("a fresh pause must not inherit the previous tally, got %d", got)
	}
}

func TestSettingTheSameValueIsANoop(t *testing.T) {
	// A repeated PUT must not reset `since` or re-broadcast, or a UI that
	// polls would look like it is toggling constantly.
	s := New(true, t0)
	changes := 0
	s.OnChange(func(State) { changes++ })

	s.Set(true, "", t0.Add(time.Hour))
	if changes != 0 {
		t.Fatalf("no-op change broadcast %d times", changes)
	}
	if !s.State().Since.Equal(t0) {
		t.Fatal("since must not move on a no-op")
	}

	s.Set(false, "", t0.Add(time.Hour))
	if changes != 1 {
		t.Fatalf("a real change should broadcast once, got %d", changes)
	}
}

func TestOnChangeReceivesTheNewState(t *testing.T) {
	s := New(true, t0)
	var got State
	s.OnChange(func(st State) { got = st })
	s.Set(false, "maintenance", t0)
	if got.Enabled || got.Reason != "maintenance" {
		t.Fatalf("callback got %+v", got)
	}
}

func TestConcurrentAccessIsSafe(t *testing.T) {
	// Enabled() is read once per detection by bus goroutines while HTTP
	// handlers write. Run with -race.
	s := New(true, t0)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				if s.Enabled() {
					s.NoteDiscarded()
				}
				if j%50 == 0 {
					s.Set(n%2 == 0, "churn", t0)
				}
				_ = s.State()
			}
		}(i)
	}
	wg.Wait()
}

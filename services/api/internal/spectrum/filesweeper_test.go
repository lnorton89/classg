package spectrum

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newFileSweeper(t *testing.T) FileSweeper {
	t.Helper()
	return FileSweeper{
		Dir:     t.TempDir(),
		Timeout: 2 * time.Second,
		Poll:    5 * time.Millisecond,
		NewID:   func() string { return "req-1" },
	}
}

// Keyed on the band file, not the directory: the state directory is shared with
// the deploy agent and the watchdog and exists on any unit running either, so
// its presence says nothing about whether a sweep agent has ever run.
func TestAvailableRequiresASweepAgentNotJustADirectory(t *testing.T) {
	var none FileSweeper
	if ok, why := none.Available(); ok || why == "" {
		t.Fatal("an unconfigured sweeper reported itself available")
	}

	f := newFileSweeper(t)
	ok, why := f.Available()
	if ok {
		t.Fatal("an empty state directory reported a sweep agent")
	}
	if why == "" {
		t.Fatal("no reason given")
	}

	if err := os.WriteFile(filepath.Join(f.Dir, bandsFile), []byte(`{"bands":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, why := f.Available(); !ok {
		t.Fatalf("still unavailable with a band file: %s", why)
	}
}

func TestBandsComeFromTheAgentsFile(t *testing.T) {
	f := newFileSweeper(t)
	body := `{"bands":[{"name":"ism_915","class":"E","start_hz":902000000,"stop_hz":928000000,"steps":14}]}`
	if err := os.WriteFile(filepath.Join(f.Dir, bandsFile), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	bands, err := f.Bands(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(bands) != 1 || bands[0].Name != "ism_915" || bands[0].Steps != 14 {
		t.Fatalf("got %+v", bands)
	}
}

// The round trip: a request appears, the agent answers, the doc comes back and
// both files are cleaned up.
func TestSweepRoundTrip(t *testing.T) {
	f := newFileSweeper(t)
	if err := os.WriteFile(filepath.Join(f.Dir, bandsFile), []byte(`{"bands":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// Stand in for the agent.
	go func() {
		reqPath := filepath.Join(f.Dir, requestFile)
		for i := 0; i < 400; i++ {
			raw, err := os.ReadFile(reqPath)
			if err == nil {
				var req sweepRequest
				_ = json.Unmarshal(raw, &req)
				_ = os.Remove(reqPath)
				res, _ := json.Marshal(sweepResult{
					ID:  req.ID,
					Doc: json.RawMessage(`{"band":"` + req.Band + `","steps":[]}`),
				})
				_ = os.WriteFile(filepath.Join(f.Dir, resultPrefix+req.ID+".json"), res, 0o644)
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()

	doc, err := f.Sweep(context.Background(), "ism_915")
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if string(doc) != `{"band":"ism_915","steps":[]}` {
		t.Fatalf("got %s", doc)
	}

	// The result is consumed, so a container restart does not re-read a sweep
	// somebody already has.
	if _, err := os.Stat(filepath.Join(f.Dir, resultPrefix+"req-1.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the result file survived being read")
	}
}

// The agent's own words carry more than anything this layer could infer, and a
// busy radio has to classify the same way it does through CommandSweeper so the
// HTTP layer answers 409 either way.
func TestAgentErrorsClassifyLikeTheCommandPath(t *testing.T) {
	f := newFileSweeper(t)
	if err := os.WriteFile(filepath.Join(f.Dir, bandsFile), []byte(`{"bands":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	go func() {
		reqPath := filepath.Join(f.Dir, requestFile)
		for i := 0; i < 400; i++ {
			raw, err := os.ReadFile(reqPath)
			if err == nil {
				var req sweepRequest
				_ = json.Unmarshal(raw, &req)
				_ = os.Remove(reqPath)
				res, _ := json.Marshal(sweepResult{
					ID:    req.ID,
					Error: "librtlsdr returned -6 opening device 0",
				})
				_ = os.WriteFile(filepath.Join(f.Dir, resultPrefix+req.ID+".json"), res, 0o644)
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()

	_, err := f.Sweep(context.Background(), "ism_915")
	if !errors.Is(err, ErrRadioBusy) {
		t.Fatalf("got %v, want ErrRadioBusy", err)
	}
}

// A missing agent must time out with a message that names the thing to check,
// rather than hanging or blaming the radio.
func TestSweepTimesOutWhenNoAgentAnswers(t *testing.T) {
	f := newFileSweeper(t)
	f.Timeout = 80 * time.Millisecond
	if err := os.WriteFile(filepath.Join(f.Dir, bandsFile), []byte(`{"bands":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := f.Sweep(context.Background(), "ism_915")
	if err == nil {
		t.Fatal("no error with no agent running")
	}
	if !contains(err.Error(), "classg-sweep-agent") {
		t.Fatalf("error %q does not name what to check", err)
	}
	// The request is withdrawn, so the agent does not later take the radio for
	// a sweep nobody is waiting for.
	if _, statErr := os.Stat(filepath.Join(f.Dir, requestFile)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("the abandoned request was left for the agent to pick up")
	}
}

// A cancelled caller withdraws the request for the same reason.
func TestCancellingWithdrawsTheRequest(t *testing.T) {
	f := newFileSweeper(t)
	if err := os.WriteFile(filepath.Join(f.Dir, bandsFile), []byte(`{"bands":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()

	if _, err := f.Sweep(ctx, "ism_915"); err == nil {
		t.Fatal("no error after cancellation")
	}
	if _, err := os.Stat(filepath.Join(f.Dir, requestFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a cancelled sweep left its request behind")
	}
}

// A request the agent has not collected means it is not running or is busy.
// Overwriting it would discard someone else's sweep.
func TestAPendingRequestIsRefusedRatherThanOverwritten(t *testing.T) {
	f := newFileSweeper(t)
	if err := os.WriteFile(filepath.Join(f.Dir, bandsFile), []byte(`{"bands":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.Dir, requestFile), []byte(`{"id":"other","band":"ism_868"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := f.Sweep(context.Background(), "ism_915")
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("got %v, want ErrBusy", err)
	}
	// And the other request is still there for the agent.
	raw, readErr := os.ReadFile(filepath.Join(f.Dir, requestFile))
	if readErr != nil || !contains(string(raw), "other") {
		t.Fatal("the pending request was clobbered")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

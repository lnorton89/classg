package deploy

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

var now = time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

func newReader(t *testing.T) Reader {
	t.Helper()
	return Reader{Dir: t.TempDir(), Now: func() time.Time { return now }}
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A dev machine has no agent. That is a normal state and must read as
// information, not as a fault -- the same shape /system uses for a reading it
// could not take.
func TestUnconfiguredIsNotAnError(t *testing.T) {
	var none Reader
	if s := none.Status(); s.Configured || s.Reason == "" {
		t.Fatalf("an unset Dir gave %+v", s)
	}
	if w := none.Watchdog(); w.Configured || w.Reason == "" {
		t.Fatalf("an unset Dir gave %+v", w)
	}

	// Configured but the agent has never run: also normal, with a reason that
	// says what to do about it.
	r := newReader(t)
	s := r.Status()
	if s.Configured {
		t.Fatal("reported configured with no state file")
	}
	if s.Reason == "" {
		t.Fatal("no reason given")
	}
}

func TestStatusReadsTheAgentsFile(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, stateFile, `{
		"commit": "aaaa1111", "commit_subject": "a change",
		"last_check_at": "2026-08-18T11:55:00Z",
		"last_result": "up-to-date",
		"remote_commit": "aaaa1111", "remote_ci": "success",
		"timer_enabled": true, "last_deploy_ok": true
	}`)

	s := r.Status()
	if !s.Configured || s.Commit != "aaaa1111" {
		t.Fatalf("got %+v", s)
	}
	if s.UpdateAvailable {
		t.Fatal("reported an update available when the commits match")
	}
	// 5 minutes between the agent's write and "now".
	if s.StateAgeS == nil || *s.StateAgeS != 300 {
		t.Fatalf("StateAgeS = %v, want 300", s.StateAgeS)
	}
}

func TestUpdateAvailableWhenRemoteDiffers(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, stateFile, `{"commit":"aaaa","remote_commit":"bbbb"}`)

	if !r.Status().UpdateAvailable {
		t.Fatal("differing commits did not report an update")
	}
}

// A missing remote_commit is "we did not check", not "there is an update".
// Reporting an update the agent never found would put a badge on a healthy unit.
func TestNoRemoteCommitIsNotAnUpdate(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, stateFile, `{"commit":"aaaa"}`)

	if r.Status().UpdateAvailable {
		t.Fatal("an absent remote_commit was reported as an update")
	}
}

// The API must not crash on a file the agent wrote badly -- it is a shell
// script building JSON with printf, and that has already gone wrong once.
func TestCorruptStateIsReportedNotFatal(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, stateFile, `{"commit": "aaaa"`)

	s := r.Status()
	if s.Configured {
		t.Fatal("truncated JSON was accepted")
	}
	if s.Reason == "" {
		t.Fatal("no reason given for unparseable state")
	}
}

func TestRequestAndCancel(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, stateFile, `{"commit":"aaaa"}`)

	if r.Status().DeployRequested {
		t.Fatal("a fresh state reported a pending request")
	}
	if err := r.Request("lee"); err != nil {
		t.Fatal(err)
	}
	if !r.Status().DeployRequested {
		t.Fatal("the request was not visible")
	}

	// Requesting twice means what requesting once means.
	if err := r.Request("lee"); err != nil {
		t.Fatalf("second Request: %v", err)
	}

	if err := r.Cancel(); err != nil {
		t.Fatal(err)
	}
	if r.Status().DeployRequested {
		t.Fatal("the request survived cancellation")
	}
	// Cancelling nothing is not an error.
	if err := r.Cancel(); err != nil {
		t.Fatalf("second Cancel: %v", err)
	}
}

func TestRequestOnAnUnconfiguredUnitFails(t *testing.T) {
	var none Reader
	if err := none.Request("lee"); err == nil {
		t.Fatal("recorded a request with nowhere to put it")
	}
}

// needs_hands is the field that matters: it is how a bounded watchdog tells a
// person it has stopped trying.
func TestWatchdogSurfacesNeedsHands(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, watchdogFile, `{
		"last_check_at": "2026-08-18T11:59:00Z",
		"actions_taken": 0,
		"needs_hands": "classg-sensor-wifi.service",
		"api_healthy": true, "wifi_adapter_present": false, "sdr_present": true,
		"log": ["GIVING UP on classg-sensor-wifi.service"]
	}`)

	w := r.Watchdog()
	if !w.Configured {
		t.Fatal("not configured")
	}
	if w.NeedsHands != "classg-sensor-wifi.service" {
		t.Fatalf("NeedsHands = %q", w.NeedsHands)
	}
	if w.WifiAdapterPresent {
		t.Fatal("an absent adapter came back present")
	}
	if w.StateAgeS == nil || *w.StateAgeS != 60 {
		t.Fatalf("StateAgeS = %v, want 60", w.StateAgeS)
	}
	if len(w.Log) != 1 {
		t.Fatalf("log %v", w.Log)
	}
}

// A healthy pass reports zero actions and nothing needing hands, which is what
// the UI renders as "nothing to do" rather than as an absence of information.
func TestWatchdogHealthyPass(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, watchdogFile, `{
		"last_check_at": "2026-08-18T12:00:00Z", "actions_taken": 0,
		"needs_hands": "", "api_healthy": true,
		"wifi_adapter_present": true, "sdr_present": true, "log": ["nothing to repair"]
	}`)

	w := r.Watchdog()
	if w.NeedsHands != "" || w.ActionsTaken != 0 || !w.APIHealthy {
		t.Fatalf("got %+v", w)
	}
}

func TestHistoryIsNewestFirstAndBounded(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, historyFile, `{"id":"1-aaaa","result":"deployed","commit":"aaaa","duration_s":91,"log":["one"]}
{"id":"2-bbbb","result":"failed","reason":"docker compose could not build","commit":"bbbb"}
{"id":"3-cccc","result":"rebuilt","commit":"cccc","artefacts":[{"name":"pi-dash","state":"rebuilt"}]}
`)

	h := r.History(0)
	if !h.Configured {
		t.Fatalf("not configured: %+v", h)
	}
	if len(h.Runs) != 3 {
		t.Fatalf("wanted 3 runs, got %d", len(h.Runs))
	}
	// Newest first: the file is appended to, so the last line is the newest.
	if h.Runs[0].ID != "3-cccc" || h.Runs[2].ID != "1-aaaa" {
		t.Fatalf("wrong order: %s ... %s", h.Runs[0].ID, h.Runs[2].ID)
	}
	if h.Runs[0].Artefacts[0].Name != "pi-dash" {
		t.Fatalf("artefacts lost: %+v", h.Runs[0])
	}
	if h.Runs[2].DurationS != 91 || h.Runs[2].Log[0] != "one" {
		t.Fatalf("fields lost: %+v", h.Runs[2])
	}

	if got := r.History(2); len(got.Runs) != 2 || got.Runs[0].ID != "3-cccc" {
		t.Fatalf("limit ignored: %+v", got.Runs)
	}
}

// The file is appended to by a shell script on a box that can lose power
// mid-write. One torn line must not cost an operator the other records.
func TestHistorySkipsATornLineRatherThanFailing(t *testing.T) {
	r := newReader(t)
	write(t, r.Dir, historyFile, `{"id":"1-aaaa","result":"deployed"}

{"id":"2-bbbb","result":"failed"}
{"id":"3-cccc","result":"rebuil
`)

	h := r.History(0)
	if len(h.Runs) != 2 {
		t.Fatalf("wanted the 2 intact runs, got %d: %+v", len(h.Runs), h.Runs)
	}
	if h.Reason != "" {
		t.Fatalf("a torn line should not be reported as a fault: %q", h.Reason)
	}
}

// A unit that has never deployed since the agent gained a history has no file.
// That is an empty list, not a misconfiguration -- and never a nil slice, which
// encodes as JSON null and makes a client check for one more thing.
func TestHistoryWithNoFileIsAnEmptyList(t *testing.T) {
	r := newReader(t)
	h := r.History(0)
	if !h.Configured || len(h.Runs) != 0 || h.Runs == nil {
		t.Fatalf("wanted a configured empty list, got %+v", h)
	}

	var none Reader
	if h := none.History(0); h.Configured || h.Reason == "" || h.Runs == nil {
		t.Fatalf("an unset Dir gave %+v", h)
	}
}

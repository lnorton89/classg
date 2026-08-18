// Package deploy reads the state that host-side agents publish, and asks them
// to do things.
//
// Two agents share the mechanism: the deploy agent, which updates what this
// unit runs, and the watchdog, which tries to keep what is already there
// running.
//
// The constraint that shapes all of it: **the API runs in a container.** It
// cannot run systemctl on the host, cannot read the host journal, and must not
// be given a way to. Handing a web-facing process a socket that can restart
// host units would make every bug in this API a host compromise.
//
// So this is a file exchange, and it is deliberately dumb. The deploy script,
// which already runs on the host as a systemd unit, writes its state to a JSON
// file after every run. The API reads it. To request a deploy the API writes a
// marker file, and the script picks it up on its next tick and deletes it.
//
// The cost is honesty about latency: "deploy now" means "at the next tick",
// which is up to ten minutes. That is stated in the UI rather than hidden, and
// it is a far better trade than a container with host control.
//
// Both paths are a bind mount shared with the host. If it is absent -- a dev
// machine, a unit that never installed the timer -- everything here reports
// "not configured" rather than failing, which is the same shape /system uses
// for a reading it could not take.
package deploy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// State is what the deploy script last did.
//
// Every field is written by the script; nothing here is computed by the API.
// One writer is what makes a plain file safe.
// Every optional timestamp is a POINTER, and that is not stylistic.
// `omitempty` does nothing on a time.Time -- it is a struct, and encoding/json
// only omits empty scalars, maps and slices. A unit that had never deployed was
// therefore sending last_deploy_at: "0001-01-01T00:00:00Z", which the web app
// read as a real date and rendered as "Dec 31, 1" next to a "rolled back"
// badge: a deploy that never happened, reported as a failure.
type State struct {
	Commit        string     `json:"commit"`
	CommitSubject string     `json:"commit_subject,omitempty"`
	CommitAt      *time.Time `json:"commit_at,omitempty"`

	// LastCheckAt is when the script last looked. A stale value means the timer
	// is not running, which is the most common "why is nothing deploying".
	LastCheckAt *time.Time `json:"last_check_at,omitempty"`
	// LastResult is one of: deploying, up-to-date, rebuilt, deployed, blocked,
	// failed.
	//
	// "rebuilt" means the tree was already current but an artefact was not --
	// a binary older than its own sources, which is how pi-dash ran an old
	// build through days of runs that all reported "up-to-date".
	//
	// "deploying" is the only one written BEFORE the thing it names. The agent
	// writes it at the start of a rebuild, which on a Pi is several minutes --
	// without it a deploy in flight is indistinguishable from an idle unit
	// showing the previous run's verdict.
	LastResult string `json:"last_result,omitempty"`
	// LastReason explains a block -- "CI is still running", "a capture is
	// running", "the working tree is dirty".
	LastReason string `json:"last_reason,omitempty"`

	LastDeployAt     *time.Time `json:"last_deploy_at,omitempty"`
	LastDeployCommit string     `json:"last_deploy_commit,omitempty"`
	// LastDeployOK is only meaningful when LastDeployAt is set. A unit that has
	// never deployed sends false here, and a client that reads it without
	// checking the timestamp renders "rolled back" for a deploy that never ran.
	LastDeployOK bool `json:"last_deploy_ok"`

	RemoteCommit string `json:"remote_commit,omitempty"`
	// RemoteCI is the CI conclusion for RemoteCommit: success, failure,
	// pending, or unknown.
	RemoteCI string `json:"remote_ci,omitempty"`

	// TimerEnabled is whether the systemd timer is active. The script knows;
	// the API cannot ask.
	TimerEnabled bool `json:"timer_enabled"`

	// Artefacts is what the agent found when it checked the things it builds
	// on this box, one entry per artefact.
	//
	// Absent rather than empty on the runs that deliberately skip the check --
	// a busy unit, a dirty tree. That distinction is the whole reason this
	// exists: a run that never looked and a run that looked and found
	// everything current are identical in a log that only speaks when it acts,
	// and pi-dash spent days stale inside exactly that blind spot.
	Artefacts []Artefact `json:"artefacts,omitempty"`

	// Log is the tail of the last run, so an operator can see what happened
	// without shelling in.
	Log []string `json:"log,omitempty"`
}

// Artefact is one thing this unit builds for itself, and what the last check
// made of it.
type Artefact struct {
	Name string `json:"name"`
	// State is one of: current, behind, rebuilt, failed, absent.
	//
	// "behind" describes the PIN rather than the build, and only a submodule
	// can be in it: the binary is current for the commit it is pinned to,
	// while upstream has moved past that commit. Both readings are true, and
	// collapsing them into "current" is how pi-dash reported itself up to date
	// on a unit that had never seen days of upstream work.
	State string `json:"state"`
}

// Status is what the API serves: State plus what it can work out itself.
type Status struct {
	Configured bool   `json:"configured"`
	Reason     string `json:"reason,omitempty"`
	State
	UpdateAvailable bool `json:"update_available"`
	DeployRequested bool `json:"deploy_requested"`
	// StateAgeS is how long ago the script last wrote. A large value means the
	// timer is not running, whatever TimerEnabled claims -- which is why both
	// are reported rather than just the flag.
	StateAgeS *int64 `json:"state_age_s,omitempty"`
}

// Reader reads and writes the shared files.
type Reader struct {
	// Dir is the bind-mounted directory. Empty disables everything here.
	Dir string
	Now func() time.Time
}

const (
	stateFile   = "deploy-state.json"
	requestFile = "deploy-requested"
	historyFile = "deploy-history.jsonl"
)

// DefaultHistoryLimit is how many past runs History returns when the caller
// does not say. The agent keeps fifty; a page showing all of them at once is a
// wall, and the interesting one is nearly always recent.
//
// HistoryMax bounds what a caller may ask for. It matches what the agent
// keeps, so asking for more is a request the file cannot satisfy anyway --
// and each run carries its whole log, which makes an unbounded limit a way to
// ask a Pi to serialise megabytes.
const (
	DefaultHistoryLimit = 20
	HistoryMax          = 50
)

// Run is one finished agent run, as recorded in the history.
//
// Only runs that did something are recorded -- deployed, failed, rebuilt -- so
// this is a list of deploys rather than a list of timer firings.
type Run struct {
	ID         string    `json:"id"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	DurationS  int64     `json:"duration_s"`
	// Result is deployed, failed, or rebuilt.
	Result string `json:"result"`
	Reason string `json:"reason,omitempty"`
	// Commit is HEAD when the run finished, so a rolled-back run names the
	// commit it went back to rather than the one it tried.
	Commit         string     `json:"commit,omitempty"`
	CommitSubject  string     `json:"commit_subject,omitempty"`
	PreviousCommit string     `json:"previous_commit,omitempty"`
	Artefacts      []Artefact `json:"artefacts,omitempty"`
	Log            []string   `json:"log,omitempty"`
}

// History is the recorded runs, newest first.
type History struct {
	Configured bool   `json:"configured"`
	Reason     string `json:"reason,omitempty"`
	Runs       []Run  `json:"runs"`
}

func (r Reader) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now().UTC()
}

func (r Reader) Enabled() bool { return r.Dir != "" }

// Status reads the current state.
func (r Reader) Status() Status {
	if !r.Enabled() {
		return Status{
			Reason: "no deploy state directory is configured (CLASSG_DEPLOY_STATE_DIR)",
		}
	}

	raw, err := os.ReadFile(filepath.Join(r.Dir, stateFile))
	if errors.Is(err, os.ErrNotExist) {
		return Status{
			Reason: "the deploy script has not run yet on this unit. Install it with " +
				"scripts/install-autodeploy.sh, or run scripts/pi-autodeploy.sh once.",
		}
	}
	if err != nil {
		return Status{Reason: "cannot read the deploy state: " + err.Error()}
	}

	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		return Status{Reason: "the deploy state file is not valid JSON: " + err.Error()}
	}

	out := Status{Configured: true, State: st}
	out.UpdateAvailable = st.RemoteCommit != "" && st.RemoteCommit != st.Commit
	out.DeployRequested = r.requested()

	if st.LastCheckAt != nil && !st.LastCheckAt.IsZero() {
		age := int64(r.now().Sub(*st.LastCheckAt).Seconds())
		out.StateAgeS = &age
	}
	return out
}

// History reads the recorded runs, newest first.
//
// JSON Lines, so a line that does not parse is SKIPPED rather than failing the
// whole read. The file is appended to by a shell script on a box that can lose
// power mid-write; one torn last line must not cost an operator the other
// forty-nine records.
func (r Reader) History(limit int) History {
	if !r.Enabled() {
		return History{
			Reason: "no deploy state directory is configured (CLASSG_DEPLOY_STATE_DIR)",
			Runs:   []Run{},
		}
	}
	if limit <= 0 {
		limit = DefaultHistoryLimit
	}

	raw, err := os.ReadFile(filepath.Join(r.Dir, historyFile))
	if errors.Is(err, os.ErrNotExist) {
		// Not an error and not a misconfiguration: a unit that has never
		// deployed since the agent gained a history has an empty list.
		return History{Configured: true, Runs: []Run{}}
	}
	if err != nil {
		return History{Reason: "cannot read the deploy history: " + err.Error(), Runs: []Run{}}
	}

	runs := make([]Run, 0, limit)
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var run Run
		if err := json.Unmarshal([]byte(line), &run); err != nil {
			continue
		}
		runs = append(runs, run)
	}

	// Newest first, and only as many as asked for. Reversed in place rather
	// than sorted by time: the file is append-only, so its order is already
	// chronological, and a run with a bad clock should not jump the queue.
	for i, j := 0, len(runs)-1; i < j; i, j = i+1, j-1 {
		runs[i], runs[j] = runs[j], runs[i]
	}
	if len(runs) > limit {
		runs = runs[:limit]
	}
	return History{Configured: true, Runs: runs}
}

// Request asks for a deploy on the next tick.
//
// Writes a marker rather than running anything. The script owns the deploy;
// this only raises a hand. Requesting twice is not an error -- pressing the
// button twice means what pressing it once means.
func (r Reader) Request(by string) error {
	if !r.Enabled() {
		return errors.New("no deploy state directory is configured on this unit")
	}
	body := fmt.Sprintf("requested_by=%s\nrequested_at=%s\n", by, r.now().Format(time.RFC3339))
	// 0644 rather than 0600: the script runs as the host user, which is not
	// necessarily the uid this container runs as.
	if err := os.WriteFile(filepath.Join(r.Dir, requestFile), []byte(body), 0o644); err != nil {
		return fmt.Errorf("recording the deploy request: %w", err)
	}
	return nil
}

// Cancel withdraws a pending request.
func (r Reader) Cancel() error {
	if !r.Enabled() {
		return errors.New("no deploy state directory is configured on this unit")
	}
	err := os.Remove(filepath.Join(r.Dir, requestFile))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (r Reader) requested() bool {
	if !r.Enabled() {
		return false
	}
	_, err := os.Stat(filepath.Join(r.Dir, requestFile))
	return err == nil
}

// --- watchdog ---------------------------------------------------------------

// WatchdogState is what the self-repair agent last did.
//
// Same exchange as the deploy agent, same directory, and for the same reason:
// the API is containerised and has no business being able to restart host
// units. It reads what the watchdog wrote and nothing more.
type WatchdogState struct {
	// Pointer for the same reason as State's -- see the comment there.
	LastCheckAt *time.Time `json:"last_check_at,omitempty"`
	// ActionsTaken in the last pass. Zero is the healthy case.
	ActionsTaken int `json:"actions_taken"`
	// NeedsHands names anything the watchdog has stopped trying to repair.
	//
	// This is the field that matters. A watchdog that retries for ever turns a
	// dead adapter into a mystery; this one climbs a bounded ladder and then
	// says so, and that message needs to reach a person.
	NeedsHands string `json:"needs_hands,omitempty"`

	APIHealthy         bool `json:"api_healthy"`
	WifiAdapterPresent bool `json:"wifi_adapter_present"`
	SDRPresent         bool `json:"sdr_present"`

	Log []string `json:"log,omitempty"`
}

// WatchdogStatus is WatchdogState plus what the API can work out itself.
type WatchdogStatus struct {
	Configured bool   `json:"configured"`
	Reason     string `json:"reason,omitempty"`
	WatchdogState
	// StateAgeS is how long since the last pass. The timer runs every two
	// minutes, so a large value means the watchdog itself is not running --
	// which is exactly the failure nothing else would notice.
	StateAgeS *int64 `json:"state_age_s,omitempty"`
}

const watchdogFile = "watchdog-state.json"

// Watchdog reads the self-repair agent's state.
func (r Reader) Watchdog() WatchdogStatus {
	if !r.Enabled() {
		return WatchdogStatus{
			Reason: "no state directory is configured (CLASSG_DEPLOY_STATE_DIR)",
		}
	}

	raw, err := os.ReadFile(filepath.Join(r.Dir, watchdogFile))
	if errors.Is(err, os.ErrNotExist) {
		return WatchdogStatus{
			Reason: "the watchdog has not run on this unit. Install it with " +
				"scripts/install-watchdog.sh.",
		}
	}
	if err != nil {
		return WatchdogStatus{Reason: "cannot read the watchdog state: " + err.Error()}
	}

	var st WatchdogState
	if err := json.Unmarshal(raw, &st); err != nil {
		return WatchdogStatus{Reason: "the watchdog state file is not valid JSON: " + err.Error()}
	}

	out := WatchdogStatus{Configured: true, WatchdogState: st}
	if st.LastCheckAt != nil && !st.LastCheckAt.IsZero() {
		age := int64(r.now().Sub(*st.LastCheckAt).Seconds())
		out.StateAgeS = &age
	}
	return out
}

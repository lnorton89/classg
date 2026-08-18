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
	"time"
)

// State is what the deploy script last did.
//
// Every field is written by the script; nothing here is computed by the API.
// One writer is what makes a plain file safe.
type State struct {
	Commit        string    `json:"commit"`
	CommitSubject string    `json:"commit_subject,omitempty"`
	CommitAt      time.Time `json:"commit_at,omitempty"`

	// LastCheckAt is when the script last looked. A stale value means the timer
	// is not running, which is the most common "why is nothing deploying".
	LastCheckAt time.Time `json:"last_check_at,omitempty"`
	// LastResult is one of: up-to-date, deployed, blocked, failed.
	LastResult string `json:"last_result,omitempty"`
	// LastReason explains a block -- "CI is still running", "a capture is
	// running", "the working tree is dirty".
	LastReason string `json:"last_reason,omitempty"`

	LastDeployAt     time.Time `json:"last_deploy_at,omitempty"`
	LastDeployCommit string    `json:"last_deploy_commit,omitempty"`
	LastDeployOK     bool      `json:"last_deploy_ok"`

	RemoteCommit string `json:"remote_commit,omitempty"`
	// RemoteCI is the CI conclusion for RemoteCommit: success, failure,
	// pending, or unknown.
	RemoteCI string `json:"remote_ci,omitempty"`

	// TimerEnabled is whether the systemd timer is active. The script knows;
	// the API cannot ask.
	TimerEnabled bool `json:"timer_enabled"`

	// Log is the tail of the last run, so an operator can see what happened
	// without shelling in.
	Log []string `json:"log,omitempty"`
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
)

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

	if !st.LastCheckAt.IsZero() {
		age := int64(r.now().Sub(st.LastCheckAt).Seconds())
		out.StateAgeS = &age
	}
	return out
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
	LastCheckAt time.Time `json:"last_check_at,omitempty"`
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
	if !st.LastCheckAt.IsZero() {
		age := int64(r.now().Sub(st.LastCheckAt).Seconds())
		out.StateAgeS = &age
	}
	return out
}

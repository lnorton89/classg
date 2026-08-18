package spectrum

// Sweeping from a container.
//
// CommandSweeper execs the sensor binary, which works when the API runs on the
// host and cannot work at all in the deployment that actually exists. The API
// container has no sensor binary, no /dev/bus/usb and no librtlsdr -- checked
// on the unit, all three absent -- so `spectrum.sdr_bin` could never point at
// anything real and the panel correctly reported "no sweep engine configured"
// for ever.
//
// The alternatives were to give the container the binary, the USB device tree
// and librtlsdr, or to hand the work to something already on the host. The
// first is a privileged container running radio code on behalf of a web-facing
// process, which is the opposite of the reasoning that keeps deploys and
// repairs out of this container. So: the same file exchange, a third time.
//
// The API writes a request and waits; a host agent runs the sweep and writes the
// result back. The agent owns the radio and the privileges; the API owns
// nothing but a directory.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// FileSweeper hands sweeps to the host agent through a shared directory.
type FileSweeper struct {
	// Dir is the shared agent-state directory. Empty disables sweeping.
	Dir string
	// Timeout bounds one sweep end to end, including the agent noticing the
	// request. fpv_1g2 is 146 tune steps, so this is minutes.
	Timeout time.Duration
	// Poll is how often the result file is checked for.
	Poll time.Duration
	// NewID mints a request id. Injected for tests.
	NewID func() string
}

const (
	bandsFile      = "spectrum-bands.json"
	requestFile    = "spectrum-request.json"
	resultPrefix   = "spectrum-result-"
	agentStateFile = "spectrum-agent.json"
)

func (f FileSweeper) poll() time.Duration {
	if f.Poll > 0 {
		return f.Poll
	}
	return time.Second
}

func (f FileSweeper) timeout() time.Duration {
	if f.Timeout > 0 {
		return f.Timeout
	}
	return 15 * time.Minute
}

// Available reports whether a sweep agent has been seen.
//
// Keyed on the band file rather than on the directory, because the directory is
// shared with the deploy agent and the watchdog and exists on any unit with
// either of those. The band file only appears once the sweep agent has run,
// which is the thing being asked about.
func (f FileSweeper) Available() (bool, string) {
	if strings.TrimSpace(f.Dir) == "" {
		return false, "no agent state directory is configured (CLASSG_DEPLOY_STATE_DIR)"
	}
	if _, err := os.Stat(filepath.Join(f.Dir, bandsFile)); err != nil {
		return false, "no sweep agent has run on this unit. The API cannot reach the radio " +
			"from inside its container; install the agent with scripts/install-sweep-agent.sh"
	}
	return true, ""
}

func (f FileSweeper) Bands(context.Context) ([]Band, error) {
	if ok, why := f.Available(); !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, why)
	}
	raw, err := os.ReadFile(filepath.Join(f.Dir, bandsFile))
	if err != nil {
		return nil, fmt.Errorf("reading the band plan: %w", err)
	}
	var doc struct {
		Bands []Band `json:"bands"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("the band plan did not decode: %w", err)
	}
	return doc.Bands, nil
}

// sweepRequest is what the agent picks up.
type sweepRequest struct {
	ID   string `json:"id"`
	Band string `json:"band"`
	At   string `json:"at"`
}

// sweepResult is what it writes back. Either Doc or Error is set.
type sweepResult struct {
	ID  string          `json:"id"`
	Doc json.RawMessage `json:"doc,omitempty"`
	// Error is the agent's own words -- librtlsdr's message, or dump1090
	// refusing to yield -- because those say more than anything this layer
	// could infer.
	Error string `json:"error,omitempty"`
}

// Sweep asks the agent and waits for the answer.
func (f FileSweeper) Sweep(ctx context.Context, band string) ([]byte, error) {
	if ok, why := f.Available(); !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, why)
	}

	id := f.newID()
	reqPath := filepath.Join(f.Dir, requestFile)
	resPath := filepath.Join(f.Dir, resultPrefix+id+".json")

	// A request already sitting there means the agent has not picked the last
	// one up. Refusing is better than overwriting someone else's sweep.
	if _, err := os.Stat(reqPath); err == nil {
		return nil, fmt.Errorf("%w: a sweep request is already waiting for the agent", ErrBusy)
	}

	body, err := json.Marshal(sweepRequest{ID: id, Band: band, At: time.Now().UTC().Format(time.RFC3339)})
	if err != nil {
		return nil, err
	}
	// 0644: the agent runs as the host user, which is not necessarily this
	// container's uid.
	if err := os.WriteFile(reqPath, body, 0o644); err != nil {
		return nil, fmt.Errorf("writing the sweep request: %w", err)
	}

	deadline := time.Now().Add(f.timeout())
	ticker := time.NewTicker(f.poll())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// The caller gave up. Withdraw the request so the agent does not
			// take the radio for a sweep nobody is waiting for.
			_ = os.Remove(reqPath)
			return nil, ctx.Err()
		case <-ticker.C:
		}

		raw, err := os.ReadFile(resPath)
		if err == nil {
			_ = os.Remove(resPath)
			var res sweepResult
			if err := json.Unmarshal(raw, &res); err != nil {
				return nil, fmt.Errorf("the sweep result did not decode: %w", err)
			}
			if res.Error != "" {
				return nil, classifyAgentError(res.Error)
			}
			if len(res.Doc) == 0 {
				return nil, errors.New("the agent returned an empty sweep")
			}
			return res.Doc, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("reading the sweep result: %w", err)
		}

		if time.Now().After(deadline) {
			// What is actually in the exchange directory, before withdrawing.
			// "The agent did not answer" is true and useless on its own: a
			// request still sitting there means nothing collected it, and a
			// result under another id means something answered a sweep this
			// caller was not waiting for. Those are different faults with
			// different fixes, and the difference is one readdir away.
			left := f.contents()
			_ = os.Remove(reqPath)
			return nil, fmt.Errorf("the sweep agent did not answer within %s. "+
				"Is classg-sweep-agent.service running on the host? "+
				"The exchange directory holds: %s", f.timeout(), left)
		}
	}
}

// classifyAgentError maps the agent's message onto the errors a caller acts on,
// reusing the same matching CommandSweeper does so both paths report a busy
// radio identically.
func classifyAgentError(msg string) error {
	return classify(msg, errors.New("the sweep failed"))
}

func (f FileSweeper) newID() string {
	if f.NewID != nil {
		return f.NewID()
	}
	return time.Now().UTC().Format("20060102T150405.000000000")
}

// AgentState is what the sweep agent publishes about itself, so the UI can say
// something better than "unavailable" when it is not running.
type AgentState struct {
	LastSeenAt time.Time `json:"last_seen_at"`
	// RadioHeldBy names what currently owns the dongle, when the agent knows.
	RadioHeldBy string `json:"radio_held_by,omitempty"`
}

// Agent reads that state. A zero value means no agent has reported.
func (f FileSweeper) Agent() (AgentState, bool) {
	if f.Dir == "" {
		return AgentState{}, false
	}
	raw, err := os.ReadFile(filepath.Join(f.Dir, agentStateFile))
	if err != nil {
		return AgentState{}, false
	}
	var st AgentState
	if err := json.Unmarshal(raw, &st); err != nil {
		return AgentState{}, false
	}
	return st, true
}

// contents lists the exchange directory for a diagnostic. Best effort: this is
// only ever called on a path that has already failed.
func (f FileSweeper) contents() string {
	entries, err := os.ReadDir(f.Dir)
	if err != nil {
		return "unreadable (" + err.Error() + ")"
	}
	if len(entries) == 0 {
		return "nothing"
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return strings.Join(names, ", ")
}

// Package capture runs passive PCAP captures on a monitor-mode interface.
//
// # Receive-only
//
// This is the only package in the api that touches a radio, so it is where the
// project's hardest constraint has to be enforced rather than assumed
// (docs/research/06-legal-and-ethics.md). Three structural properties do that:
//
//  1. The argv is built here, from constants. No part of it comes from the
//     request body except an interface name and a channel number, both of
//     which are validated against allowlists.
//  2. No shell is ever involved, so there is no argument that can smuggle in a
//     second command.
//  3. The only two programs invoked are `iw` (to read interface state and to
//     set a receive channel) and `tcpdump` (to read frames). Neither is asked
//     to do anything that emits RF: no active-monitor flag -- which is also
//     what wedges mt7921u -- no injection, and no association.
//
// The BPF filter is fixed at management beacons. Filtering in the kernel is
// both the privacy-preserving choice and the one first-capture.sh already
// makes, so a capture taken through the api matches one taken by hand.
package capture

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/proc"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/ulid"
)

// beaconFilter is the same expression scripts/first-capture.sh uses. Management
// beacons only: neighbours' data frames never reach userspace.
const beaconFilter = "type mgt subtype beacon"

// ifaceRE is deliberately strict. Linux caps interface names at 15 characters,
// and anything outside this set has no business being passed to exec.
//
// The leading character is constrained separately: a name like "-i" satisfies
// every other rule but would be read by tcpdump as a flag rather than as an
// interface, which turns a validated field back into argument injection.
var ifaceRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$`)

// allowedChannels mirrors services/sensor-wifi/config/channels.yaml plus the
// 2.4 GHz channels that file omits. 6 GHz is absent on purpose: the US regdb
// sets NO-IR there, which disables passive listening entirely.
var allowedChannels = func() map[int]bool {
	m := map[int]bool{}
	for ch := 1; ch <= 14; ch++ {
		m[ch] = true
	}
	for _, ch := range []int{36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 149, 153, 157, 161, 165} {
		m[ch] = true
	}
	return m
}()

const (
	minDuration = 1
	maxDuration = 3600
)

type Request struct {
	Iface     string `json:"iface"`
	Channel   int    `json:"channel"`
	DurationS int    `json:"duration_s"`
	Label     string `json:"label"`
}

// Options configures the manager.
type Options struct {
	Dir string
	// AllowUnprivileged skips the euid check. Development only: tcpdump will
	// fail on its own, but the failure arrives after the 202 rather than as a
	// clean 503.
	AllowUnprivileged bool
	PythonBin         string
	SensorWifiDir     string
	// AnalyzeTimeout bounds one analyzer run. Zero means defaultAnalyzeTimeout.
	AnalyzeTimeout time.Duration
	// OnUpdate publishes capture.status frames.
	OnUpdate func(model.Capture)
}

type Manager struct {
	opts  Options
	store store.Store

	mu      sync.Mutex
	running map[string]context.CancelFunc
	// busy holds the interfaces a capture currently owns. Claimed by Start
	// before any I/O and released when the capture's goroutine finishes, so
	// two Starts cannot interleave. running alone is not enough: the id is
	// only inserted after preflight, and that window is exactly where a second
	// Start used to slip in.
	//
	// Per interface, not one flag for the whole manager. The exclusion exists
	// because a capture retunes a radio (see ErrBusy), and this unit now has
	// two Wi-Fi receivers on separate radios -- a single flag made recording
	// the TP-Link sweep adapter refuse while the ALFA was busy, for a
	// collision that cannot happen between two different devices.
	busy map[string]bool
	// analysing holds the capture ids with an analyzer running. Separate from
	// busy: that one is about radios, this one is about CPU, and the two
	// contend for nothing in common.
	analysing map[string]bool
}

func NewManager(st store.Store, opts Options) *Manager {
	return &Manager{
		opts:      opts,
		store:     st,
		running:   map[string]context.CancelFunc{},
		busy:      map[string]bool{},
		analysing: map[string]bool{},
	}
}

// ErrPrivileges means the machine cannot capture, not that the request was bad.
var ErrPrivileges = errors.New("privileges required")

// ErrBusy means a capture is already running. The monitor interface is a
// single exclusive resource: a second capture would retune the shared radio
// under the first AND under the wifi sensor's channel hopper. Sweeps grew an
// ErrBusy gate for exactly this collision; captures get the same one.
var ErrBusy = errors.New("a capture is already running on this interface")

// commandTimeout bounds the iw invocations. A wedged mt7921u can hang iw
// inside the kernel, and without a deadline that pinned the handler goroutine
// (preflight) or leaked the capture goroutine (channel set) forever.
const commandTimeout = 10 * time.Second

// ValidationError is a bad request body; Field names the offending member.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

// ErrNotMonitor means the interface exists but is not in monitor mode.
var ErrNotMonitor = errors.New("interface is not in monitor mode")

// Validate checks a request without touching hardware. Split out so the rules
// are testable on any platform.
func Validate(req Request) (Request, error) {
	req.Iface = strings.TrimSpace(req.Iface)
	if req.Iface == "" {
		return req, &ValidationError{"iface", "iface is required"}
	}
	if !ifaceRE.MatchString(req.Iface) {
		return req, &ValidationError{"iface", fmt.Sprintf("iface %q is not a valid interface name", req.Iface)}
	}
	if !allowedChannels[req.Channel] {
		return req, &ValidationError{"channel", fmt.Sprintf("channel %d is not a listenable Wi-Fi channel", req.Channel)}
	}
	if req.DurationS == 0 {
		req.DurationS = 120
	}
	if req.DurationS < minDuration || req.DurationS > maxDuration {
		return req, &ValidationError{"duration_s", fmt.Sprintf("duration_s must be between %d and %d", minDuration, maxDuration)}
	}
	req.Label = sanitiseLabel(req.Label)
	return req, nil
}

// sanitiseLabel keeps the label to characters that are safe in a filename on
// every platform the captures directory might be read on.
func sanitiseLabel(label string) string {
	label = strings.TrimSpace(label)
	var b strings.Builder
	for _, r := range label {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('-')
		}
		if b.Len() >= 48 {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}

// Start validates, pre-flights the machine, and launches tcpdump.
//
// Pre-flight matters because the contract wants a 503 with
// privileges_required, not a 202 followed by a capture that silently fails
// two seconds later.
func (m *Manager) Start(ctx context.Context, req Request) (model.Capture, error) {
	req, err := Validate(req)
	if err != nil {
		return model.Capture{}, err
	}

	// Claim this interface's radio before any I/O. Released by fail() below on
	// every error path, or by run()'s defer once the capture ends.
	m.mu.Lock()
	if m.busy[req.Iface] {
		m.mu.Unlock()
		return model.Capture{}, ErrBusy
	}
	m.busy[req.Iface] = true
	m.mu.Unlock()
	fail := func(err error) (model.Capture, error) {
		m.mu.Lock()
		delete(m.busy, req.Iface)
		m.mu.Unlock()
		return model.Capture{}, err
	}

	if err := m.preflight(ctx, req.Iface); err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(m.opts.Dir, 0o755); err != nil {
		return fail(fmt.Errorf("capture directory: %w", err))
	}

	now := time.Now().UTC()
	label := req.Label
	if label == "" {
		label = "capture"
	}
	c := model.Capture{
		CaptureID: ulid.New(now),
		Filename:  fmt.Sprintf("%s-%s.pcap", now.Format("2006-01-02-150405"), label),
		State:     model.CaptureRunning,
		StartedAt: now,
		Iface:     req.Iface,
		Channel:   req.Channel,
		DurationS: req.DurationS,
		Label:     req.Label,
	}
	if err := m.store.PutCapture(ctx, c); err != nil {
		return fail(err)
	}

	// Detached from the request context: the capture outlives the HTTP call
	// that started it, and is stopped by POST /captures/{id}/stop or by its
	// own duration.
	runCtx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	m.running[c.CaptureID] = cancel
	m.mu.Unlock()

	go m.run(runCtx, c)
	m.publish(c)
	return c, nil
}

func (m *Manager) preflight(ctx context.Context, iface string) error {
	for _, tool := range []string{"tcpdump", "iw"} {
		if _, err := exec.LookPath(tool); err != nil {
			return fmt.Errorf("%w: %s is not installed or not on PATH", ErrPrivileges, tool)
		}
	}
	if !m.opts.AllowUnprivileged && os.Geteuid() != 0 {
		return fmt.Errorf("%w: monitor-mode capture needs root; run the api as root, "+
			"grant tcpdump CAP_NET_RAW, or set CLASSG_CAPTURE_ALLOW_UNPRIVILEGED=true to try anyway",
			ErrPrivileges)
	}

	// Read-only check. The api deliberately does not put the interface into
	// monitor mode itself: that is a persistent change to host network state,
	// and scripts/setup-monitor.sh already owns it along with the mt7921u
	// landmines documented in docs/ops/02-wifi-adapter.md.
	//
	// Bounded, because the request context carries no deadline of its own and
	// iw against a wedged adapter can hang in the kernel.
	iwCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	out, err := proc.Command(iwCtx, "iw", "dev", iface, "info").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: cannot read %s (%v)", ErrPrivileges, iface, err)
	}
	if !strings.Contains(string(out), "type monitor") {
		return fmt.Errorf("%w: %s is not in monitor mode; run scripts/setup-monitor.sh %s first",
			ErrNotMonitor, iface, iface)
	}
	return nil
}

func (m *Manager) run(ctx context.Context, c model.Capture) {
	defer func() {
		m.mu.Lock()
		delete(m.running, c.CaptureID)
		delete(m.busy, c.Iface)
		m.mu.Unlock()
	}()

	path := filepath.Join(m.opts.Dir, c.Filename)

	// Setting the receive channel is the only mutation this package performs,
	// and it is receive-side tuning: it changes what the radio listens to, not
	// what it emits. Bounded like preflight's iw call, and for the same wedge.
	tuneCtx, cancelTune := context.WithTimeout(ctx, commandTimeout)
	out, err := proc.Command(tuneCtx, "iw", "dev", c.Iface, "set", "channel",
		fmt.Sprint(c.Channel)).CombinedOutput()
	cancelTune()
	if err != nil {
		m.finish(c, model.CaptureFailed, fmt.Sprintf("setting channel %d: %v: %s", c.Channel, err, strings.TrimSpace(string(out))))
		return
	}

	deadline, cancel := context.WithTimeout(ctx, time.Duration(c.DurationS)*time.Second)
	defer cancel()

	cmd := proc.Command(deadline, "tcpdump",
		"-i", c.Iface,
		"-w", path,
		"-s", "0",
		"-U", // flush per packet so size_bytes is meaningful while running
		beaconFilter,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		m.finish(c, model.CaptureFailed, fmt.Sprintf("starting tcpdump: %v", err))
		return
	}
	err = cmd.Wait()

	// tcpdump killed by its deadline or by an explicit stop is the normal way
	// a capture ends, not a failure.
	stopped := deadline.Err() != nil || ctx.Err() != nil
	if err != nil && !stopped {
		m.finish(c, model.CaptureFailed, fmt.Sprintf("tcpdump: %v: %s", err, strings.TrimSpace(stderr.String())))
		return
	}
	m.finish(c, model.CaptureCompleted, "")
}

func (m *Manager) finish(c model.Capture, state, errMsg string) {
	now := time.Now().UTC()
	c.State = state
	c.EndedAt = &now
	c.Error = errMsg

	path := filepath.Join(m.opts.Dir, c.Filename)
	if fi, err := os.Stat(path); err == nil {
		c.SizeBytes = fi.Size()
		c.FrameCount = countFrames(path)
	}
	if err := m.store.PutCapture(context.Background(), c); err != nil {
		// The file exists on disk regardless, so there is nothing to retry --
		// but this is the write that moves the capture out of "running", and
		// losing it silently leaves a row that never finishes. An operator sees
		// a capture stuck mid-flight for ever, with the finished PCAP sitting
		// next to it and nothing anywhere saying why.
		slog.Error("recording the finished capture failed; it will still show as running",
			"capture_id", c.CaptureID, "state", state, "file", c.Filename, "err", err)
	}
	m.publish(c)
}

// countFrames asks tcpdump how many frames landed in the file.
//
// Parsing the PCAP header ourselves would avoid a subprocess, but tcpdump is
// already a hard dependency of this package and it understands every link type
// a monitor-mode capture might use, including the radiotap variants.
func (m *Manager) publish(c model.Capture) {
	if m.opts.OnUpdate != nil {
		m.opts.OnUpdate(c)
	}
}

// Stop ends a running capture. Stopping a finished capture is a conflict, not
// a silent success: the caller asked for a state change that cannot happen.
func (m *Manager) Stop(ctx context.Context, id string) (model.Capture, error) {
	c, err := m.store.GetCapture(ctx, id)
	if err != nil {
		return model.Capture{}, err
	}
	m.mu.Lock()
	cancel, ok := m.running[id]
	m.mu.Unlock()
	if !ok {
		return c, fmt.Errorf("capture %s is %s, not running", id, c.State)
	}
	cancel()
	return c, nil
}

// Path returns the on-disk location of a capture's PCAP, refusing anything
// that does not resolve inside the capture directory.
//
// Filenames are generated by Start rather than supplied by clients, so this is
// belt and braces -- but the alternative failure is serving arbitrary files off
// the Pi, and the check is four lines.
func (m *Manager) Path(c model.Capture) (string, error) {
	dir, err := filepath.Abs(m.opts.Dir)
	if err != nil {
		return "", err
	}
	full, err := filepath.Abs(filepath.Join(dir, filepath.Base(c.Filename)))
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(full, dir+string(os.PathSeparator)) {
		return "", fmt.Errorf("capture path escapes the capture directory")
	}
	return full, nil
}

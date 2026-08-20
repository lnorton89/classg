package spectrum

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/proc"
	"github.com/classg/api/internal/store"
)

// Errors a caller distinguishes. Everything else is an internal failure.
var (
	// ErrUnavailable means this machine cannot sweep at all: no binary, or one
	// built without the `rtlsdr` feature.
	ErrUnavailable = errors.New("the sweep engine is not available")
	// ErrBusy means a sweep is already running. The radio is a single exclusive
	// device; two sweeps would fight over it and both would be wrong.
	ErrBusy = errors.New("a sweep is already running")
	// ErrRadioBusy means something else holds the dongle -- on a working unit
	// that is dump1090, which owns it by design (ADR-0008).
	ErrRadioBusy = errors.New("the radio is in use")
	// ErrUnknownBand means the band name is not in the sensor's plan.
	ErrUnknownBand = errors.New("unknown band")
)

// Sweeper runs one band sweep and returns the raw document.
type Sweeper interface {
	Bands(ctx context.Context) ([]Band, error)
	Sweep(ctx context.Context, band string) ([]byte, error)
	Available() (bool, string)
}

// CommandSweeper shells out to the SDR sensor binary.
//
// A subprocess rather than a link: the sweep engine is Rust, it needs
// librtlsdr, and the api must keep building and running on a machine that has
// neither. The same reasoning already puts tcpdump behind a subprocess in
// internal/capture.
//
// There is no shell. Argv[0] is a configured path and the only value derived
// from a request is the band name, which is checked against the sensor's own
// plan before it is passed -- so nothing a client sends can become a second
// command.
type CommandSweeper struct {
	// Bin is the sensor binary. Empty disables sweeping entirely.
	Bin string
	// Timeout bounds one sweep. fpv_1g2 is 146 tune steps, so this is minutes,
	// not seconds -- but it is bounded, because a wedged USB device makes a
	// read block forever rather than fail (ADR-0003).
	Timeout time.Duration
}

func (c CommandSweeper) Available() (bool, string) {
	if strings.TrimSpace(c.Bin) == "" {
		return false, "no sweep binary configured (CLASSG_SDR_BIN)"
	}
	if _, err := exec.LookPath(c.Bin); err != nil {
		return false, c.Bin + " is not executable from the API runtime"
	}
	return true, ""
}

func (c CommandSweeper) Bands(ctx context.Context) ([]Band, error) {
	out, err := c.run(ctx, 10*time.Second, "bands", "--json")
	if err != nil {
		return nil, err
	}
	var doc struct {
		Bands []Band `json:"bands"`
	}
	if err := unmarshalJSONLine(out, &doc); err != nil {
		return nil, fmt.Errorf("reading the band plan: %w", err)
	}
	return doc.Bands, nil
}

func (c CommandSweeper) Sweep(ctx context.Context, band string) ([]byte, error) {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	return c.run(ctx, timeout, "sweep", "--band", band, "--json")
}

func (c CommandSweeper) run(ctx context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	if ok, why := c.Available(); !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, why)
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := proc.Command(ctx, c.Bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err == nil {
		return stdout.Bytes(), nil
	}

	// The sensor puts progress and diagnostics on stderr and keeps stdout to
	// the one JSON document, so stderr is the whole explanation of a failure.
	msg := strings.TrimSpace(stderr.String())
	if ctx.Err() != nil {
		return nil, fmt.Errorf("the sweep did not finish within %s: %s", timeout, firstLine(msg))
	}
	return nil, classify(msg, err)
}

// classify maps the sensor's own words onto the errors a caller acts on.
//
// Matching on text is fragile in general; it is right here because the
// alternative is worse. librtlsdr signals "another process has the device" as
// exit status with a libusb code, and reporting that to an operator as a 500
// would send them looking for a broken API when the actual state is a working
// one -- dump1090 holding the radio is how a healthy unit looks (ADR-0008).
func classify(stderr string, err error) error {
	low := strings.ToLower(stderr)
	switch {
	case strings.Contains(low, "no band called"):
		return fmt.Errorf("%w: %s", ErrUnknownBand, firstLine(stderr))
	case strings.Contains(low, "without the `rtlsdr` feature"):
		return fmt.Errorf("%w: the sensor binary was built without radio support", ErrUnavailable)
	case strings.Contains(low, "-6") && strings.Contains(low, "librtlsdr"),
		strings.Contains(low, "device or resource busy"),
		strings.Contains(low, "in use"):
		return fmt.Errorf("%w: %s", ErrRadioBusy, firstLine(stderr))
	case strings.Contains(low, "no sdr found"), strings.Contains(low, "devicenotfound"),
		strings.Contains(low, "no device"):
		return fmt.Errorf("%w: no SDR is attached", ErrUnavailable)
	}
	if stderr == "" {
		return fmt.Errorf("the sweep failed: %w", err)
	}
	return fmt.Errorf("the sweep failed: %s", firstLine(stderr))
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// unmarshalJSONLine decodes the last non-empty line of output.
//
// The sensor is careful to keep stdout to one document, but a `.env` loader or
// a library writing to stdout would otherwise turn a working sweep into a parse
// error. Taking the last line survives that without accepting garbage: the line
// still has to be the document.
func unmarshalJSONLine(out []byte, v any) error {
	lines := bytes.Split(out, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		return json.Unmarshal(line, v)
	}
	return errors.New("the sweep produced no output")
}

// Service serialises sweeps and records them.
//
// One at a time, always. The radio is one exclusive USB device, so a second
// concurrent sweep does not run slower -- it fails to open, and the first one's
// retunes get interleaved with nothing. Refusing is the honest answer.
type Service struct {
	Store   store.Store
	Sweeper Sweeper
	// NewID mints a sweep id. Injected so tests are deterministic.
	NewID func() string
	// Now is the clock, injected for the same reason.
	Now func() time.Time

	// OnUpdate is called every time a sweep changes state: started, completed,
	// failed. The API wires it to the hub so an open browser learns the sweep
	// landed instead of waiting for a poll to notice.
	//
	// It is called with the RECORD only. The measurement stays in the store --
	// a completed fpv_1g2 sweep is over a megabyte of bins, and pushing that
	// down every socket to announce a state change would cost more than the
	// sweep did.
	//
	// Called from the sweep's own goroutine, so an implementation that blocks
	// holds the radio. The hub's Broadcast does not block, which is the whole
	// reason it is shaped that way.
	OnUpdate func(model.SpectrumSweep)

	mu      sync.Mutex
	running string
}

// Bands is the sensor's own band plan. Asked of the binary rather than kept in
// Go, so the two cannot drift.
func (s *Service) Bands(ctx context.Context) ([]Band, error) {
	if s.Sweeper == nil {
		return nil, fmt.Errorf("%w: no sweep engine configured", ErrUnavailable)
	}
	if ok, why := s.Sweeper.Available(); !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, why)
	}
	return s.Sweeper.Bands(ctx)
}

// Available reports whether this unit can sweep at all, and why not.
func (s *Service) Available() (bool, string) { return s.available() }

// Running reports the id of the in-flight sweep, or "".
func (s *Service) Running() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

// Start records a sweep as running and returns immediately.
//
// The sweep itself continues on its own goroutine with its own context: a
// client that disconnects mid-sweep must not abort it, because the radio has
// already been taken from dump1090 and abandoning it halfway costs the ADS-B
// outage without producing the measurement it was spent on.
func (s *Service) Start(ctx context.Context, band string) (model.SpectrumSweep, error) {
	if ok, why := s.available(); !ok {
		return model.SpectrumSweep{}, fmt.Errorf("%w: %s", ErrUnavailable, why)
	}

	bands, err := s.Sweeper.Bands(ctx)
	if err != nil {
		return model.SpectrumSweep{}, err
	}
	var plan *Band
	for i := range bands {
		if bands[i].Name == band {
			plan = &bands[i]
			break
		}
	}
	if plan == nil {
		return model.SpectrumSweep{}, fmt.Errorf("%w: %q", ErrUnknownBand, band)
	}

	s.mu.Lock()
	if s.running != "" {
		id := s.running
		s.mu.Unlock()
		return model.SpectrumSweep{}, fmt.Errorf("%w (%s)", ErrBusy, id)
	}
	id := s.NewID()
	s.running = id
	s.mu.Unlock()

	sweep := model.SpectrumSweep{
		SweepID:   id,
		Band:      plan.Name,
		State:     model.SweepRunning,
		StartedAt: s.now(),
		Class:     plan.Class,
		Note:      plan.Note,
		StartHz:   plan.StartHz,
		StopHz:    plan.StopHz,
		Steps:     plan.Steps,
	}
	if err := s.Store.PutSweep(ctx, sweep); err != nil {
		s.finish(id)
		return model.SpectrumSweep{}, err
	}

	s.publish(sweep)
	go s.run(sweep)
	return sweep, nil
}

func (s *Service) available() (bool, string) {
	if s.Sweeper == nil {
		return false, "no sweep engine configured"
	}
	return s.Sweeper.Available()
}

func (s *Service) finish(id string) {
	s.mu.Lock()
	if s.running == id {
		s.running = ""
	}
	s.mu.Unlock()
}

// run does the sweep and writes the outcome. Detached from the request, so it
// uses a background context bounded by the sweeper's own timeout.
func (s *Service) run(sweep model.SpectrumSweep) {
	defer s.finish(sweep.SweepID)

	raw, err := s.Sweeper.Sweep(context.Background(), sweep.Band)
	ended := s.now()
	sweep.EndedAt = &ended

	if err != nil {
		sweep.State = model.SweepFailed
		sweep.Error = err.Error()
		_ = s.Store.PutSweep(context.Background(), sweep)
		s.publish(sweep)
		return
	}

	doc, err := ParseDoc(raw)
	if err != nil {
		sweep.State = model.SweepFailed
		sweep.Error = err.Error()
		_ = s.Store.PutSweep(context.Background(), sweep)
		s.publish(sweep)
		return
	}

	sweep.State = model.SweepCompleted
	sweep.NoiseFloorDBFS = doc.NoiseFloorDBFS
	sweep.ThresholdDBFS = doc.ThresholdDBFS
	sweep.PeakHz, sweep.PeakDBFS = doc.Peak()
	sweep.Steps = len(doc.Steps)
	sweep.ShortReads = len(doc.ShortReads)

	ctx := context.Background()
	if err := s.Store.PutSweep(ctx, sweep); err != nil {
		return
	}
	// Bins last. If this fails the sweep is still recorded as completed with a
	// floor and a peak -- a partial record beats losing the whole measurement
	// because the largest column would not write.
	_ = s.Store.PutSweepBins(ctx, sweep.SweepID, raw)

	// After the bins, not before. A client told "completed" fetches the trace
	// immediately, and announcing the state change first is a race it would
	// lose -- it would ask for a measurement that is still being written and
	// cache the answer forever.
	s.publish(sweep)
}

func (s *Service) publish(sweep model.SpectrumSweep) {
	if s.OnUpdate != nil {
		s.OnUpdate(sweep)
	}
}

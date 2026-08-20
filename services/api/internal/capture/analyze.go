package capture

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/proc"
	"github.com/classg/api/internal/store"
)

//go:embed analyze_json.py
var analyzeAdapter []byte

// ErrAnalyzerUnavailable means the Wi-Fi sensor's Python environment is not
// usable from here -- a machine problem, not a bad request.
var ErrAnalyzerUnavailable = fmt.Errorf("capture analyzer unavailable")

// ErrAnalyzing means this capture is already being analysed.
//
// A 409 rather than a second subprocess. Analysis is the most expensive thing
// this API does -- a scapy pass over tens of megabytes, on the same four cores
// that are decoding Wi-Fi frames on a deadline -- and the request that starts
// it has no visible progress, so an operator who waits ten seconds and clicks
// again is the expected behaviour, not the unusual one.
var ErrAnalyzing = errors.New("this capture is already being analysed")

// defaultAnalyzeTimeout is used when Options.AnalyzeTimeout is unset.
//
// The other subprocesses in this package are bounded for a stated reason: "a
// wedged mt7921u can hang iw inside the kernel, and without a deadline that
// pinned the handler goroutine forever". That reason applies here with more
// force, not less. This one is the longest-running of the three, it parses a
// file this unit did not write, and the api sets no WriteTimeout (it would cut
// the WebSocket stream), so the request context is only cancelled when the
// client goes away -- which a polling client never does.
const defaultAnalyzeTimeout = 5 * time.Minute

// analysisReport is only the subset the captures list summary needs. The full
// report is stored and served verbatim, so adding a field to the Python
// adapter does not require a change here.
type analysisReport struct {
	DroneTransmitters int `json:"drone_transmitters"`
	Drones            []struct {
		ODIDBeacons int `json:"odid_beacons"`
		DJIBeacons  int `json:"dji_beacons"`
	} `json:"drones"`
}

// Analyze runs the classg_wifi analysis pipeline over a completed capture and
// stores the structured report.
//
// It shells out to Python because that is where the parsers live (ADR-0001);
// reimplementing ODID and DJI decode in Go to avoid a subprocess would mean
// two parsers to keep in step with the same firmware churn.
func (m *Manager) Analyze(ctx context.Context, id string) (json.RawMessage, model.CaptureAnalysis, error) {
	c, err := m.store.GetCapture(ctx, id)
	if err != nil {
		return nil, model.CaptureAnalysis{}, err
	}
	if c.State == model.CaptureRunning {
		return nil, model.CaptureAnalysis{}, fmt.Errorf("capture %s is still running", id)
	}
	path, err := m.Path(c)
	if err != nil {
		return nil, model.CaptureAnalysis{}, err
	}
	if _, err := os.Stat(path); err != nil {
		return nil, model.CaptureAnalysis{}, fmt.Errorf("%w: capture file %s is missing", store.ErrNotFound, c.Filename)
	}

	// One analysis per capture. Claimed after the checks above so a bad
	// request cannot leave a capture permanently "already being analysed",
	// and released by the defer whatever happens next.
	m.mu.Lock()
	if m.analysing[id] {
		m.mu.Unlock()
		return nil, model.CaptureAnalysis{}, ErrAnalyzing
	}
	if m.analysing == nil {
		m.analysing = map[string]bool{}
	}
	m.analysing[id] = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.analysing, id)
		m.mu.Unlock()
	}()

	script, cleanup, err := m.materialiseAdapter()
	if err != nil {
		return nil, model.CaptureAnalysis{}, err
	}
	defer cleanup()

	timeout := m.opts.AnalyzeTimeout
	if timeout <= 0 {
		timeout = defaultAnalyzeTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := proc.Command(runCtx, m.opts.PythonBin, script, path)
	cmd.Dir = m.opts.SensorWifiDir // so `import classg_wifi` resolves
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// Say which of the two happened. "analyzer unavailable: signal: killed"
		// is what a timeout looks like otherwise, and it sends an operator
		// looking for a missing Python environment that is working fine.
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return nil, model.CaptureAnalysis{}, fmt.Errorf(
				"%w: analysing %s took longer than %s and was abandoned; raise capture.analyze_timeout if the capture is large",
				ErrAnalyzerUnavailable, c.Filename, timeout)
		}
		return nil, model.CaptureAnalysis{}, fmt.Errorf("%w: %v: %s",
			ErrAnalyzerUnavailable, err, firstLine(stderr.String()))
	}

	report := json.RawMessage(bytes.TrimSpace(stdout.Bytes()))
	if !json.Valid(report) {
		return nil, model.CaptureAnalysis{}, fmt.Errorf("%w: analyzer produced no JSON: %s",
			ErrAnalyzerUnavailable, firstLine(stderr.String()))
	}

	var parsed analysisReport
	if err := json.Unmarshal(report, &parsed); err != nil {
		return nil, model.CaptureAnalysis{}, fmt.Errorf("%w: %v", ErrAnalyzerUnavailable, err)
	}
	summary := model.CaptureAnalysis{Analyzed: true, DroneTransmitters: parsed.DroneTransmitters}
	for _, d := range parsed.Drones {
		summary.ClassA += d.ODIDBeacons
		summary.ClassB += d.DJIBeacons
	}

	if err := m.store.PutCaptureReport(ctx, id, report, summary); err != nil {
		return nil, model.CaptureAnalysis{}, err
	}
	if updated, err := m.store.GetCapture(ctx, id); err == nil {
		m.publish(updated)
	}
	return report, summary, nil
}

// materialiseAdapter writes the embedded script to a temporary file.
//
// Embedding keeps the api a single binary -- the whole point of serving the UI
// from the same process -- while still letting the adapter be an ordinary
// Python file that can be linted and read.
func (m *Manager) materialiseAdapter() (string, func(), error) {
	dir, err := os.MkdirTemp("", "classg-analyze-")
	if err != nil {
		return "", func() {}, fmt.Errorf("%w: %v", ErrAnalyzerUnavailable, err)
	}
	path := filepath.Join(dir, "analyze_json.py")
	if err := os.WriteFile(path, analyzeAdapter, 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return "", func() {}, fmt.Errorf("%w: %v", ErrAnalyzerUnavailable, err)
	}
	return path, func() { _ = os.RemoveAll(dir) }, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		// Python tracebacks put the useful line last, not first.
		lines := strings.Split(s, "\n")
		return strings.TrimSpace(lines[len(lines)-1])
	}
	return s
}

package capture

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

//go:embed analyze_json.py
var analyzeAdapter []byte

// ErrAnalyzerUnavailable means the Wi-Fi sensor's Python environment is not
// usable from here -- a machine problem, not a bad request.
var ErrAnalyzerUnavailable = fmt.Errorf("capture analyzer unavailable")

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

	script, cleanup, err := m.materialiseAdapter()
	if err != nil {
		return nil, model.CaptureAnalysis{}, err
	}
	defer cleanup()

	cmd := exec.CommandContext(ctx, m.opts.PythonBin, script, path)
	cmd.Dir = m.opts.SensorWifiDir // so `import classg_wifi` resolves
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
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

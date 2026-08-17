package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/httpapi"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/monitoring"
	"github.com/classg/api/internal/settings"
	"github.com/classg/api/internal/spectrum"
	"github.com/classg/api/internal/store/memstore"
)

// stubSweeper stands in for the sensor binary. `unavail` makes the unit look
// like one with no SDR, which is every machine except a Pi.
type stubSweeper struct {
	out     []byte
	err     error
	unavail string
	bandErr error
	block   chan struct{}
}

func (s *stubSweeper) Available() (bool, string) {
	if s.unavail != "" {
		return false, s.unavail
	}
	return true, ""
}

func (s *stubSweeper) Bands(context.Context) ([]spectrum.Band, error) {
	if s.bandErr != nil {
		return nil, s.bandErr
	}
	return []spectrum.Band{{
		Name: "ism_915", Class: "E", Note: "ELRS 900",
		StartHz: 902_000_000, StopHz: 928_000_000, Steps: 14,
	}}, nil
}

func (s *stubSweeper) Sweep(context.Context, string) ([]byte, error) {
	if s.block != nil {
		<-s.block
	}
	return s.out, s.err
}

// A two-step sweep with a plottable shape: eight coarse bins per step, a guard
// of one, and a peak in step two.
func stubSweepDoc() []byte {
	return []byte(`{"band":"ism_915","class":"E","note":"ELRS 900",
	"start_hz":902000000,"stop_hz":928000000,"sample_rate":2400000,"fft_size":8,
	"dc_guard_bins":1,"gain_tenth_db":200,"noise_floor_dbfs":-70.5,
	"threshold_dbfs":-60.5,"threshold_over_floor_db":10,"short_reads":[],
	"steps":[
	 {"center_hz":903000000,"first_bin_hz":901800000,"bin_width_hz":300000,
	  "bins_dbfs":[-70,-71,-70,-52,-70,-70,-71,-70],"peak_hz":902400000,"peak_dbfs":-70},
	 {"center_hz":904920000,"first_bin_hz":903720000,"bin_width_hz":300000,
	  "bins_dbfs":[-70,-71,-70,-52,-45,-70,-71,-70],"peak_hz":905220000,"peak_dbfs":-45}
	]}`)
}

type sweepHarness struct {
	server *httpapi.Server
	svc    *spectrum.Service
	store  *memstore.Store
}

func newSweepHarness(t *testing.T, sw spectrum.Sweeper) *sweepHarness {
	t.Helper()
	env := map[string]string{
		"CLASSG_STORE":              "memory",
		"CLASSG_TRACK_ENDPOINT":     "off",
		"CLASSG_DETECTION_ENDPOINT": "off",
		"CLASSG_UI_DIR":             t.TempDir(),
	}
	getenv := func(k string) string { return env[k] }

	boot, err := config.LoadBootstrap(getenv)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	set, err := settings.Resolve(nil, nil, getenv)
	if err != nil {
		t.Fatalf("settings: %v", err)
	}
	cfg, err := config.Assemble(boot, set)
	if err != nil {
		t.Fatalf("config: %v", err)
	}

	st := memstore.New()
	var svc *spectrum.Service
	if sw != nil {
		n := 0
		svc = &spectrum.Service{
			Store: st, Sweeper: sw,
			NewID: func() string { n++; return fmt.Sprintf("sweep-%d", n) },
			Now:   func() time.Time { return time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC) },
		}
	}

	return &sweepHarness{
		server: httpapi.New(httpapi.Options{
			Config: cfg, Settings: set, Store: st,
			Registry:   health.NewRegistry(cfg.SensorStaleAfter),
			Hub:        hub.New(),
			Captures:   capture.NewManager(st, capture.Options{Dir: t.TempDir()}),
			Monitoring: monitoring.New(false, time.Now().UTC()),
			Spectrum:   svc,
			Sensors:    fakeSensors{},
			Started:    time.Now(),
		}),
		svc: svc, store: st,
	}
}

func (h *sweepHarness) do(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.server.ServeHTTP(w, r)
	return w
}

// waitForSweep blocks until the sweep reaches a terminal state.
func (h *sweepHarness) waitForSweep(t *testing.T, id string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got, err := h.store.GetSweep(context.Background(), id)
		if err == nil && got.State != "running" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("sweep %s never finished", id)
}

func TestSweepEndToEndProducesAPlottableTrace(t *testing.T) {
	h := newSweepHarness(t, &stubSweeper{out: stubSweepDoc()})

	w := h.do(t, "POST", "/api/v1/spectrum/sweeps", `{"band":"ism_915"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("POST returned %d: %s", w.Code, w.Body)
	}
	var started struct {
		SweepID string `json:"sweep_id"`
		State   string `json:"state"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.State != "running" {
		t.Fatalf("state %q, want running", started.State)
	}

	h.waitForSweep(t, started.SweepID)

	w = h.do(t, "GET", "/api/v1/spectrum/sweeps/"+started.SweepID, "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET returned %d: %s", w.Code, w.Body)
	}
	var got struct {
		State          string   `json:"state"`
		NoiseFloorDBFS *float64 `json:"noise_floor_dbfs"`
		PeakDBFS       *float64 `json:"peak_dbfs"`
		Trace          *struct {
			StartHz    float64    `json:"start_hz"`
			StopHz     float64    `json:"stop_hz"`
			BinWidthHz float64    `json:"bin_width_hz"`
			DBFS       []*float64 `json:"dbfs"`
			Blind      int        `json:"blind"`
		} `json:"trace"`
		StepPeaks []struct {
			CenterHz int64    `json:"center_hz"`
			PeakDBFS *float64 `json:"peak_dbfs"`
		} `json:"step_peaks"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.State != "completed" {
		t.Fatalf("state %q", got.State)
	}
	if got.NoiseFloorDBFS == nil || *got.NoiseFloorDBFS != -70.5 {
		t.Fatalf("noise floor %v", got.NoiseFloorDBFS)
	}
	if got.PeakDBFS == nil || *got.PeakDBFS != -45 {
		t.Fatalf("peak %v, want the -45 dBFS from step two", got.PeakDBFS)
	}
	if got.Trace == nil || len(got.Trace.DBFS) == 0 {
		t.Fatal("no trace on a completed sweep")
	}
	if len(got.StepPeaks) != 2 {
		t.Fatalf("%d step peaks, want 2", len(got.StepPeaks))
	}

	// The -52 dBFS bins are each step's DC guard -- the receiver's own local
	// oscillator. They must not reach the trace at any level.
	for i, v := range got.Trace.DBFS {
		if v != nil && *v > -50 {
			continue // the genuine -45 peak
		}
		if v != nil && *v > -55 && *v <= -50 {
			t.Fatalf("cell %d carries %.1f dBFS -- the LO leaked past the DC guard", i, *v)
		}
	}
	if got.Trace.Blind == 0 {
		t.Fatal("no blind cells: the DC guards were silently filled in")
	}
	// A blind cell has to arrive as null, not 0. Zero dBFS is full scale.
	if !strings.Contains(w.Body.String(), "null") {
		t.Fatal("the trace contains no nulls, so unmeasured cells became numbers")
	}
}

// The radio is exclusive. A second sweep is a conflict, not a server error:
// nothing is broken, the dongle is busy.
func TestASecondSweepIsAConflictNotAFailure(t *testing.T) {
	block := make(chan struct{})
	h := newSweepHarness(t, &stubSweeper{out: stubSweepDoc(), block: block})

	if w := h.do(t, "POST", "/api/v1/spectrum/sweeps", `{"band":"ism_915"}`); w.Code != http.StatusAccepted {
		t.Fatalf("first POST: %d %s", w.Code, w.Body)
	}
	// Wait until the sweeper has actually taken the radio.
	deadline := time.Now().Add(2 * time.Second)
	for h.svc.Running() == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}

	w := h.do(t, "POST", "/api/v1/spectrum/sweeps", `{"band":"ism_915"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("second POST returned %d, want 409: %s", w.Code, w.Body)
	}
	if code := decodeErr(t, w).Error.Code; code != "conflict" {
		t.Fatalf("error code %q, want conflict", code)
	}
	close(block)
}

// dump1090 owning the radio is a healthy unit (ADR-0008), so it is a 409 with
// the radio's own words -- not a 500 that sends an operator hunting a bug.
func TestARadioHeldByDump1090ReportsAConflict(t *testing.T) {
	h := newSweepHarness(t, &stubSweeper{
		err: fmt.Errorf("%w: librtlsdr returned -6 opening device 0", spectrum.ErrRadioBusy),
	})

	w := h.do(t, "POST", "/api/v1/spectrum/sweeps", `{"band":"ism_915"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("POST: %d %s", w.Code, w.Body)
	}
	var started struct {
		SweepID string `json:"sweep_id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &started)
	h.waitForSweep(t, started.SweepID)

	w = h.do(t, "GET", "/api/v1/spectrum/sweeps/"+started.SweepID, "")
	body := w.Body.String()
	if !strings.Contains(body, "failed") || !strings.Contains(body, "librtlsdr") {
		t.Fatalf("the failure did not reach the record: %s", body)
	}
	// No trace, rather than an empty one that charts as a flat quiet band.
	if strings.Contains(body, `"trace"`) {
		t.Fatalf("a failed sweep carried a trace: %s", body)
	}
}

// A unit with no SDR is a working unit with one fewer sensor. The band list
// still answers, and says why it is empty (ADR-0003).
func TestBandsOnAUnitWithNoRadioExplainsItself(t *testing.T) {
	h := newSweepHarness(t, &stubSweeper{unavail: "no sweep binary configured (CLASSG_SDR_BIN)"})

	w := h.do(t, "GET", "/api/v1/spectrum/bands", "")
	if w.Code != http.StatusOK {
		t.Fatalf("bands returned %d, want 200 -- a missing radio is not an API failure", w.Code)
	}
	var got struct {
		Bands     []any  `json:"bands"`
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Available {
		t.Fatal("reported available with no sweep binary")
	}
	if !strings.Contains(got.Reason, "CLASSG_SDR_BIN") {
		t.Fatalf("reason %q does not say what is missing", got.Reason)
	}
	if got.Bands == nil {
		t.Fatal("bands must be an empty array, not null")
	}
}

// With no spectrum service at all -- the default build -- starting a sweep is
// an unavailable sensor, not a crash.
func TestSweepingWithoutAServiceIsUnavailable(t *testing.T) {
	h := newSweepHarness(t, nil)

	w := h.do(t, "POST", "/api/v1/spectrum/sweeps", `{"band":"ism_915"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("POST returned %d, want 503: %s", w.Code, w.Body)
	}
	if w := h.do(t, "GET", "/api/v1/spectrum/bands", ""); w.Code != http.StatusOK {
		t.Fatalf("bands returned %d, want 200", w.Code)
	}
	if w := h.do(t, "GET", "/api/v1/spectrum/sweeps", ""); w.Code != http.StatusOK {
		t.Fatalf("list returned %d, want 200", w.Code)
	}
}

// The band name reaches a subprocess argv. It is checked against the sensor's
// own plan, so anything else is a 400 and never runs.
func TestAnUnknownBandIsRejectedBeforeItReachesTheRadio(t *testing.T) {
	h := newSweepHarness(t, &stubSweeper{out: stubSweepDoc()})

	for _, band := range []string{`"wifi_2g4"`, `""`, `"ism_915 --emit-sample-detection"`, `"; reboot"`} {
		w := h.do(t, "POST", "/api/v1/spectrum/sweeps", `{"band":`+band+`}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("band %s returned %d, want 400: %s", band, w.Code, w.Body)
		}
		if f := decodeErr(t, w).Error.Field; f != "band" {
			t.Fatalf("error field %q, want band", f)
		}
	}
}

func TestSweepListIsEmptyArrayNotNull(t *testing.T) {
	h := newSweepHarness(t, &stubSweeper{out: stubSweepDoc()})

	w := h.do(t, "GET", "/api/v1/spectrum/sweeps", "")
	if body := strings.TrimSpace(w.Body.String()); !strings.Contains(body, `"sweeps":[]`) {
		t.Fatalf("empty list serialised as %s", body)
	}
}

func TestSweepDetailForAnUnknownIDIs404(t *testing.T) {
	h := newSweepHarness(t, &stubSweeper{out: stubSweepDoc()})

	w := h.do(t, "GET", "/api/v1/spectrum/sweeps/nope", "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", w.Code)
	}
}

// The trace width is a client-supplied loop bound, so it is bounded.
func TestTraceWidthIsValidated(t *testing.T) {
	h := newSweepHarness(t, &stubSweeper{out: stubSweepDoc()})
	w := h.do(t, "POST", "/api/v1/spectrum/sweeps", `{"band":"ism_915"}`)
	var started struct {
		SweepID string `json:"sweep_id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &started)
	h.waitForSweep(t, started.SweepID)

	base := "/api/v1/spectrum/sweeps/" + started.SweepID
	for _, q := range []string{"?bins=0", "?bins=-1", "?bins=abc", "?bins=100000"} {
		if w := h.do(t, "GET", base+q, ""); w.Code != http.StatusBadRequest {
			t.Fatalf("%s returned %d, want 400", q, w.Code)
		}
	}
	if w := h.do(t, "GET", base+"?bins=64", ""); w.Code != http.StatusOK {
		t.Fatalf("a valid width returned %d: %s", w.Code, w.Body)
	}
}

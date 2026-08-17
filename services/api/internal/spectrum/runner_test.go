package spectrum

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store/memstore"
)

// fakeSweeper stands in for the sensor binary.
type fakeSweeper struct {
	bands     []Band
	out       []byte
	err       error
	unavail   string
	started   chan struct{}
	release   chan struct{}
	mu        sync.Mutex
	sweepCall int
}

func (f *fakeSweeper) Available() (bool, string) {
	if f.unavail != "" {
		return false, f.unavail
	}
	return true, ""
}

func (f *fakeSweeper) Bands(context.Context) ([]Band, error) { return f.bands, nil }

func (f *fakeSweeper) Sweep(context.Context, string) ([]byte, error) {
	f.mu.Lock()
	f.sweepCall++
	f.mu.Unlock()
	if f.started != nil {
		close(f.started)
		f.started = nil
	}
	if f.release != nil {
		<-f.release
	}
	return f.out, f.err
}

func (f *fakeSweeper) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sweepCall
}

func testBands() []Band {
	return []Band{{Name: "ism_915", Class: "E", Note: "ELRS 900", StartHz: 902_000_000, StopHz: 928_000_000, Steps: 14}}
}

func sampleSweep() []byte {
	return []byte(`{"band":"ism_915","class":"E","note":"ELRS 900","start_hz":902000000,
	"stop_hz":928000000,"sample_rate":2400000,"fft_size":8,"dc_guard_bins":1,
	"gain_tenth_db":200,"noise_floor_dbfs":-70.5,"threshold_dbfs":-60.5,
	"threshold_over_floor_db":10.0,"short_reads":[],
	"steps":[{"center_hz":902960000,"first_bin_hz":901760000,"bin_width_hz":300000,
	"bins_dbfs":[-70,-71,-70,-58,-70,-70,-71,-70],"peak_hz":902341000,"peak_dbfs":-65.5}]}`)
}

func newService(f *fakeSweeper) (*Service, *memstore.Store) {
	st := memstore.New()
	n := 0
	return &Service{
		Store:   st,
		Sweeper: f,
		NewID:   func() string { n++; return fmt.Sprintf("sweep-%d", n) },
		Now:     func() time.Time { return time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC) },
	}, st
}

// waitFor polls until cond or the deadline. The sweep runs on its own
// goroutine, deliberately, so tests wait rather than reaching into it.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartRecordsASweepAndThenItsMeasurement(t *testing.T) {
	f := &fakeSweeper{bands: testBands(), out: sampleSweep()}
	svc, st := newService(f)

	sw, err := svc.Start(context.Background(), "ism_915")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if sw.State != model.SweepRunning {
		t.Fatalf("state %q, want running", sw.State)
	}
	if sw.Class != "E" || sw.Steps != 14 {
		t.Fatalf("metadata not taken from the band plan: %+v", sw)
	}

	waitFor(t, "the sweep to complete", func() bool {
		got, err := st.GetSweep(context.Background(), sw.SweepID)
		return err == nil && got.State == model.SweepCompleted
	})

	got, err := st.GetSweep(context.Background(), sw.SweepID)
	if err != nil {
		t.Fatalf("GetSweep: %v", err)
	}
	if got.NoiseFloorDBFS == nil || *got.NoiseFloorDBFS != -70.5 {
		t.Fatalf("noise floor %v, want -70.5", got.NoiseFloorDBFS)
	}
	if got.PeakDBFS == nil || *got.PeakDBFS != -65.5 {
		t.Fatalf("peak %v, want -65.5", got.PeakDBFS)
	}
	if got.EndedAt == nil {
		t.Fatal("a completed sweep must have an end time")
	}

	bins, err := st.GetSweepBins(context.Background(), sw.SweepID)
	if err != nil {
		t.Fatalf("GetSweepBins: %v", err)
	}
	if d, err := ParseDoc(bins); err != nil || len(d.Steps) != 1 {
		t.Fatalf("stored bins do not parse back: %v", err)
	}
}

// The radio is one exclusive USB device. A second sweep does not run slower, it
// fails to open -- so refusing is the honest answer, and the refusal names the
// sweep already holding it.
func TestStartRefusesASecondConcurrentSweep(t *testing.T) {
	f := &fakeSweeper{
		bands:   testBands(),
		out:     sampleSweep(),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	started := f.started
	svc, _ := newService(f)

	first, err := svc.Start(context.Background(), "ism_915")
	if err != nil {
		t.Fatalf("first Start: %v", err)
	}
	<-started

	_, err = svc.Start(context.Background(), "ism_915")
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("second Start returned %v, want ErrBusy", err)
	}
	if !strings.Contains(err.Error(), first.SweepID) {
		t.Fatalf("refusal %q does not name the running sweep %s", err, first.SweepID)
	}

	close(f.release)
	waitFor(t, "the radio to be released", func() bool { return svc.Running() == "" })

	if _, err := svc.Start(context.Background(), "ism_915"); err != nil {
		t.Fatalf("Start after the first finished: %v", err)
	}
	waitFor(t, "the second sweep to run", func() bool { return f.calls() == 2 })
}

// dump1090 holding the radio is what a healthy unit looks like (ADR-0008), so
// the failure has to arrive as a reason on the record rather than a lost sweep.
func TestAFailedSweepIsRecordedWithItsReason(t *testing.T) {
	f := &fakeSweeper{
		bands: testBands(),
		err:   fmt.Errorf("%w: librtlsdr -6", ErrRadioBusy),
	}
	svc, st := newService(f)

	sw, err := svc.Start(context.Background(), "ism_915")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	waitFor(t, "the sweep to fail", func() bool {
		got, err := st.GetSweep(context.Background(), sw.SweepID)
		return err == nil && got.State == model.SweepFailed
	})

	got, _ := st.GetSweep(context.Background(), sw.SweepID)
	if !strings.Contains(got.Error, "librtlsdr -6") {
		t.Fatalf("error %q does not carry the radio's reason", got.Error)
	}
	if got.NoiseFloorDBFS != nil {
		t.Fatalf("a failed sweep reported a noise floor of %v", *got.NoiseFloorDBFS)
	}
	// No bins, and the absence is reported as such rather than as an empty
	// measurement that would chart as a flat band.
	if _, err := st.GetSweepBins(context.Background(), sw.SweepID); err == nil {
		t.Fatal("a failed sweep stored bins")
	}
	// The radio has to be released even though the sweep failed, or one busy
	// dongle wedges every future sweep.
	waitFor(t, "the radio to be released after a failure", func() bool { return svc.Running() == "" })
}

// The band name reaches a subprocess argv, so it is checked against the
// sensor's own plan first rather than passed through.
func TestStartRejectsABandTheSensorDoesNotKnow(t *testing.T) {
	f := &fakeSweeper{bands: testBands(), out: sampleSweep()}
	svc, _ := newService(f)

	for _, band := range []string{"", "wifi_2g4", "ism_915; rm -rf /", "--help"} {
		_, err := svc.Start(context.Background(), band)
		if !errors.Is(err, ErrUnknownBand) {
			t.Fatalf("Start(%q) returned %v, want ErrUnknownBand", band, err)
		}
	}
	if f.calls() != 0 {
		t.Fatalf("the sweeper ran %d times for bands that do not exist", f.calls())
	}
}

func TestStartOnAMachineThatCannotSweepSaysSo(t *testing.T) {
	f := &fakeSweeper{bands: testBands(), unavail: "no sweep binary configured (CLASSG_SDR_BIN)"}
	svc, _ := newService(f)

	_, err := svc.Start(context.Background(), "ism_915")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("got %v, want ErrUnavailable", err)
	}
	if !strings.Contains(err.Error(), "CLASSG_SDR_BIN") {
		t.Fatalf("refusal %q does not say what to configure", err)
	}
}

// Output that is not a sweep must fail the sweep, not store a document the
// charts will read as a measurement.
func TestOutputThatIsNotASweepFailsTheSweep(t *testing.T) {
	f := &fakeSweeper{bands: testBands(), out: []byte("Segmentation fault\n")}
	svc, st := newService(f)

	sw, _ := svc.Start(context.Background(), "ism_915")
	waitFor(t, "the sweep to fail", func() bool {
		got, err := st.GetSweep(context.Background(), sw.SweepID)
		return err == nil && got.State == model.SweepFailed
	})
}

func TestClassifyTurnsTheSensorsWordsIntoActionableErrors(t *testing.T) {
	cases := []struct {
		stderr string
		want   error
	}{
		{"librtlsdr returned -6 opening device 0", ErrRadioBusy},
		{"usb_claim_interface error -6\nlibrtlsdr: failed", ErrRadioBusy},
		{"Device or resource busy", ErrRadioBusy},
		{"built without the `rtlsdr` feature, so this binary cannot talk to a radio.", ErrUnavailable},
		{"no SDR found.", ErrUnavailable},
		{`no band called "wifi_2g4". Known bands:`, ErrUnknownBand},
	}
	for _, c := range cases {
		err := classify(c.stderr, errors.New("exit status 1"))
		if !errors.Is(err, c.want) {
			t.Errorf("classify(%q) = %v, want %v", firstLine(c.stderr), err, c.want)
		}
	}

	// Anything unrecognised still reports the sensor's own first line rather
	// than swallowing it into a generic failure.
	err := classify("tuner PLL not locked at 1360000000", errors.New("exit status 1"))
	if !strings.Contains(err.Error(), "PLL not locked") {
		t.Errorf("unrecognised stderr was swallowed: %v", err)
	}
}

// Anything a library prints to stdout before the document must not turn a
// working sweep into a parse failure.
func TestJSONLineSurvivesChatterAheadOfTheDocument(t *testing.T) {
	var got struct {
		Bands []Band `json:"bands"`
	}
	out := []byte("libusb: warning [get_usbfs_fd]\n{\"bands\":[{\"name\":\"ism_915\"}]}\n\n")
	if err := unmarshalJSONLine(out, &got); err != nil {
		t.Fatalf("unmarshalJSONLine: %v", err)
	}
	if len(got.Bands) != 1 || got.Bands[0].Name != "ism_915" {
		t.Fatalf("got %+v", got.Bands)
	}

	if err := unmarshalJSONLine([]byte("   \n\n"), &got); err == nil {
		t.Fatal("empty output was accepted")
	}
}

func TestCommandSweeperWithNoBinaryIsUnavailableNotAnError(t *testing.T) {
	ok, why := CommandSweeper{}.Available()
	if ok {
		t.Fatal("an unconfigured sweeper reported itself available")
	}
	if !strings.Contains(why, "CLASSG_SDR_BIN") {
		t.Fatalf("reason %q does not name the setting", why)
	}

	_, err := CommandSweeper{}.Sweep(context.Background(), "ism_915")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("got %v, want ErrUnavailable", err)
	}
}

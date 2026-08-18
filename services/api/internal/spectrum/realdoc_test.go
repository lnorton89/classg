package spectrum_test

import (
	"os"
	"testing"

	"github.com/classg/api/internal/spectrum"
)

// The Rust sensor writes this document and Go reads it, which makes it a wire
// contract between two languages with no shared type. Every other test in this
// package builds its input in Go, so all of them would keep passing if the
// sensor changed a field name tomorrow.
//
// testdata/pi-ism_868.json is not synthesised. It is the output of
// `classg-sensor-sdr sweep --band ism_868 --json` on the unit -- an RTL-SDR V4
// on a Pi 4, real antenna, real air -- captured through the same file exchange
// the API uses in production. Regenerate it the same way if the format moves;
// do not hand-edit it, because the point is that nobody chose these numbers.
func TestParsePiSweep(t *testing.T) {
	raw, err := os.ReadFile("testdata/pi-ism_868.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := spectrum.ParseDoc(raw)
	if err != nil {
		t.Fatalf("the sensor's own output did not decode: %v", err)
	}

	if doc.Band != "ism_868" {
		t.Errorf("band = %q, want ism_868", doc.Band)
	}
	if len(doc.Steps) == 0 {
		t.Fatal("no steps decoded; a field name has probably drifted")
	}
	// A zero here means the field name matched nothing and Go filled in the
	// zero value -- which decodes without error and is the failure this test
	// exists to catch.
	for _, f := range []struct {
		name string
		got  int64
	}{
		{"start_hz", doc.StartHz},
		{"stop_hz", doc.StopHz},
		{"sample_rate", int64(doc.SampleRate)},
		{"fft_size", int64(doc.FFTSize)},
		{"dc_guard_bins", int64(doc.DCGuardBins)},
		{"center_hz", doc.Steps[0].CenterHz},
	} {
		if f.got == 0 {
			t.Errorf("%s decoded as 0", f.name)
		}
	}
	if doc.Steps[0].BinWidthHz <= 0 {
		t.Error("bin_width_hz decoded as 0")
	}
	if len(doc.Steps[0].BinsDBFS) != doc.FFTSize {
		t.Errorf("step 0 has %d bins, fft_size says %d",
			len(doc.Steps[0].BinsDBFS), doc.FFTSize)
	}
	if doc.NoiseFloorDBFS == nil {
		t.Error("noise_floor_dbfs decoded as nil on a completed sweep")
	}

	// The stitched trace is what the browser draws. Real air is never silent
	// across a whole ISM band, so an all-nil trace here means the DC guards or
	// the step geometry were misread rather than that the band was quiet.
	trace := spectrum.Stitch(doc, spectrum.DefaultTraceWidth)
	if len(trace.DBFS) == 0 {
		t.Fatal("the trace has no cells")
	}
	measured := len(trace.DBFS) - trace.Blind
	if measured == 0 {
		t.Fatal("every cell is a gap")
	}
	if trace.Blind == 0 {
		t.Error("no cells are gaps; a zero-IF receiver has a DC notch per step " +
			"and a trace without one has filled them in")
	}
	// Covers the band rather than equals it. A 2.4 MHz step centred near a band
	// edge measures outside it, and Stitch reports what was measured -- so the
	// trace is wider here, by 240 kHz at the bottom and 918 kHz at the top.
	if trace.StartHz > float64(doc.StartHz) || trace.StopHz < float64(doc.StopHz) {
		t.Errorf("trace spans %.0f-%.0f Hz, which does not cover the band's %d-%d",
			trace.StartHz, trace.StopHz, doc.StartHz, doc.StopHz)
	}

	// dBFS is power relative to full scale, so a positive reading is louder
	// than the ADC can represent. Bounded rather than pinned: these are
	// measurements of whatever was on the air that afternoon.
	for i, v := range trace.DBFS {
		if v == nil {
			continue
		}
		if *v > 0 || *v < -200 {
			t.Fatalf("cell %d reads %.1f dBFS, outside anything physical", i, *v)
		}
	}
}

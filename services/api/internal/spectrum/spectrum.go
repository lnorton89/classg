// Package spectrum turns the SDR sensor's sweep output into something a chart
// can draw without lying about it.
//
// The sensor measures ENERGY and nothing else -- a power spectrum says a
// transmission exists, where it is and how strong, and recovers no symbol and
// no payload (services/sensor-sdr/src/sweep.rs, docs/research/06-legal-and-
// ethics.md). Nothing here classifies, and nothing here may grow a detector:
// deciding that a burst train is ELRS rather than a smart meter is Milestone 3
// and needs a transmitter to validate against.
package spectrum

import (
	"encoding/json"
	"fmt"
	"math"
)

// Doc is the sensor's `sweep --json` output. Field names match
// services/sensor-sdr/src/sweepdoc.rs exactly; a rename on one side without the
// other is a silent wire mismatch, which is what the round-trip tests on both
// sides exist to catch.
type Doc struct {
	Band                 string    `json:"band"`
	Class                string    `json:"class"`
	Note                 string    `json:"note"`
	StartHz              int64     `json:"start_hz"`
	StopHz               int64     `json:"stop_hz"`
	SampleRate           int       `json:"sample_rate"`
	FFTSize              int       `json:"fft_size"`
	DCGuardBins          int       `json:"dc_guard_bins"`
	GainTenthDB          int       `json:"gain_tenth_db"`
	NoiseFloorDBFS       *float64  `json:"noise_floor_dbfs"`
	ThresholdDBFS        *float64  `json:"threshold_dbfs"`
	ThresholdOverFloorDB float64   `json:"threshold_over_floor_db"`
	Steps                []DocStep `json:"steps"`
	ShortReads           []int64   `json:"short_reads"`
}

type DocStep struct {
	CenterHz   int64     `json:"center_hz"`
	FirstBinHz float64   `json:"first_bin_hz"`
	BinWidthHz float64   `json:"bin_width_hz"`
	BinsDBFS   []float64 `json:"bins_dbfs"`
	PeakHz     *float64  `json:"peak_hz"`
	PeakDBFS   *float64  `json:"peak_dbfs"`
}

// Band is one entry of the sensor's band plan.
type Band struct {
	Name    string `json:"name"`
	Class   string `json:"class"`
	Note    string `json:"note"`
	StartHz int64  `json:"start_hz"`
	StopHz  int64  `json:"stop_hz"`
	Steps   int    `json:"steps"`
}

// ParseDoc decodes one sweep document.
func ParseDoc(b []byte) (Doc, error) {
	var d Doc
	if err := json.Unmarshal(b, &d); err != nil {
		return Doc{}, fmt.Errorf("decoding sweep: %w", err)
	}
	if d.Band == "" {
		return Doc{}, fmt.Errorf("decoding sweep: no band name")
	}
	return d, nil
}

// Peak is the strongest bin across the whole sweep, DC guards already excluded
// by the sensor. Returns nil when nothing measured.
func (d Doc) Peak() (hz *float64, db *float64) {
	for _, s := range d.Steps {
		if s.PeakDBFS == nil || s.PeakHz == nil {
			continue
		}
		if db == nil || *s.PeakDBFS > *db {
			db, hz = s.PeakDBFS, s.PeakHz
		}
	}
	return hz, db
}

// Trace is a band rendered as one continuous line, low frequency to high.
type Trace struct {
	StartHz float64 `json:"start_hz"`
	StopHz  float64 `json:"stop_hz"`
	// BinWidthHz is the width of one output cell, which is wider than one FFT
	// bin whenever the trace was decimated.
	BinWidthHz float64 `json:"bin_width_hz"`
	// DBFS holds one entry per cell. A nil is a frequency the receiver could
	// not see -- every step covering it had it inside a DC guard, or no step
	// covered it at all. It is NOT a quiet frequency, and a renderer that joins
	// across it draws a level that was never measured.
	DBFS []*float64 `json:"dbfs"`
	// Blind counts the nil cells, so a caller can say "3 of 1200 cells
	// unmeasured" without walking the array.
	Blind int `json:"blind"`
}

// HzAt is the centre frequency of cell i.
func (t Trace) HzAt(i int) float64 {
	return t.StartHz + (float64(i)+0.5)*t.BinWidthHz
}

// MaxTraceWidth caps what a client can ask for. Past this the trace is finer
// than the measurement behind it and the extra cells are interpolation
// pretending to be data.
const MaxTraceWidth = 4096

// DefaultTraceWidth is a few times the horizontal pixels a chart gets on a
// phone, so max-hold decimation happens here rather than in the browser's
// line renderer -- which drops peaks instead of holding them.
const DefaultTraceWidth = 1200

// Stitch flattens the per-step spectra into one trace.
//
// Three things happen here, and each is a correctness decision rather than a
// presentation one:
//
// Each step's DC guard is dropped. Those bins are the receiver's own local
// oscillator, not the air (spectrum.rs) -- plotting them draws a 12 dB spike at
// the centre of every step, which is exactly the bug real hardware found in the
// sweep's first run.
//
// Overlapping steps are combined with max-hold. `plan_sweep` overlaps by 20%
// so the rolled-off outer fifth of each passband is measured again nearer the
// centre of its neighbour, and max-hold takes the better of the two readings
// rather than averaging a good one with a rolled-off one.
//
// That overlap does NOT close the DC notches, and this stitcher does not
// pretend otherwise. Centres are 1.92 MHz apart while each step spans 2.4 MHz,
// so no step contains another step's centre -- each notch stays a nil, once
// every 1.92 MHz. That is 0.8% of the band and narrower than anything this
// sensor is looking for (spectrum.rs has the measurement), but it is a hole,
// and a hole rendered as a floor reading would be a quiet frequency that was
// never actually quiet.
//
// Decimation to `width` is also max-hold. A peak two bins wide is the entire
// point of the measurement, and mean-decimation is precisely the operation that
// buries it in the surrounding noise.
func Stitch(d Doc, width int) Trace {
	if width <= 0 {
		width = DefaultTraceWidth
	}
	if width > MaxTraceWidth {
		width = MaxTraceWidth
	}

	lo, hi, binHz, ok := extent(d)
	if !ok {
		return Trace{DBFS: []*float64{}}
	}

	// Never finer than the measurement. Asking for 4096 cells across a band
	// sampled with 1024 bins would produce three empty cells for every filled
	// one, and a chart full of gaps reads as a broken receiver rather than as
	// an over-eager request.
	if maxCells := int((hi - lo) / binHz); maxCells > 0 && width > maxCells {
		width = maxCells
	}

	cellHz := (hi - lo) / float64(width)
	out := make([]*float64, width)

	for _, s := range d.Steps {
		guardLo, guardHi := guardRange(len(s.BinsDBFS), d.DCGuardBins)
		for i, db := range s.BinsDBFS {
			if i >= guardLo && i < guardHi {
				continue
			}
			cell := int((s.FirstBinHz + float64(i)*s.BinWidthHz - lo) / cellHz)
			if cell < 0 || cell >= width {
				continue
			}
			if out[cell] == nil || db > *out[cell] {
				v := db
				out[cell] = &v
			}
		}
	}

	blind := 0
	for _, v := range out {
		if v == nil {
			blind++
		}
	}

	return Trace{
		StartHz:    lo,
		StopHz:     hi,
		BinWidthHz: cellHz,
		DBFS:       out,
		Blind:      blind,
	}
}

// extent is the span actually measured, not the span requested.
//
// These differ: a 2.4 MHz step centred inside a 1.74 MHz band (ism_433 is
// exactly one such step) measures well outside the band edges. Reporting the
// nominal band would throw away real spectrum the radio saw, and reporting a
// span no step covered would open a gap at each end.
func extent(d Doc) (lo, hi, binHz float64, ok bool) {
	for _, s := range d.Steps {
		if len(s.BinsDBFS) == 0 || s.BinWidthHz <= 0 {
			continue
		}
		first := s.FirstBinHz
		last := s.FirstBinHz + float64(len(s.BinsDBFS)-1)*s.BinWidthHz
		if !ok {
			lo, hi, binHz, ok = first, last, s.BinWidthHz, true
			continue
		}
		lo = math.Min(lo, first)
		hi = math.Max(hi, last)
		binHz = math.Min(binHz, s.BinWidthHz)
	}
	return lo, hi, binHz, ok && hi > lo
}

// guardRange is the half-open index range of the receiver's own LO within one
// step, matching SweepStepDoc::dc_guard_range on the Rust side.
func guardRange(n, guardBins int) (int, int) {
	if n == 0 || guardBins < 0 {
		return 0, 0
	}
	dc := n / 2
	lo := dc - guardBins
	if lo < 0 {
		lo = 0
	}
	hi := dc + guardBins + 1
	if hi > n {
		hi = n
	}
	return lo, hi
}

package spectrum

import (
	"encoding/json"
	"math"
	"testing"
)

// step builds one tune step of `bins` flat bins centred on centerHz across
// 2.4 MHz, the sensor's stable sample rate.
func step(centerHz int64, bins int, level float64) DocStep {
	binHz := 2_400_000.0 / float64(bins)
	vals := make([]float64, bins)
	for i := range vals {
		vals[i] = level
	}
	return DocStep{
		CenterHz:   centerHz,
		FirstBinHz: float64(centerHz) - 1_200_000.0,
		BinWidthHz: binHz,
		BinsDBFS:   vals,
	}
}

func doc(steps ...DocStep) Doc {
	return Doc{
		Band:        "test",
		SampleRate:  2_400_000,
		FFTSize:     len(steps[0].BinsDBFS),
		DCGuardBins: 3,
		Steps:       steps,
	}
}

// cellFor finds the trace cell holding a frequency.
func cellFor(tr Trace, hz float64) int {
	return int((hz - tr.StartHz) / tr.BinWidthHz)
}

// The bug real hardware found, now one layer up: the LO spike must not reach a
// chart. A single step has nothing to cover its own notch, so the centre must
// come back nil -- unmeasured -- rather than as the receiver's own 12 dB spike.
func TestStitchLeavesASingleStepsDCNotchBlind(t *testing.T) {
	s := step(915_000_000, 1024, -70)
	// The LO, as a zero-IF receiver actually reports it.
	for i := 509; i < 516; i++ {
		s.BinsDBFS[i] = -58
	}

	tr := Stitch(doc(s), 512)

	c := cellFor(tr, 915_000_000)
	if tr.DBFS[c] != nil {
		t.Fatalf("centre cell reported %.1f dBFS; the DC guard must render as unmeasured", *tr.DBFS[c])
	}
	if tr.Blind == 0 {
		t.Fatal("a single-step sweep must report its DC notch as blind")
	}
	for i, v := range tr.DBFS {
		if v != nil && *v > -60 {
			t.Fatalf("cell %d reported %.1f dBFS; the LO leaked into the trace", i, *v)
		}
	}
}

// The overlap covers step EDGES, not step centres, and this is the arithmetic
// that says so. spectrum.rs used to claim the neighbouring step covered each
// DC notch; at plan_sweep's 20% overlap it cannot, and asserting it here means
// the claim is checked rather than believed.
//
// Centres 1.92 MHz apart, steps 2.4 MHz wide: a step reaches 1.2 MHz either
// side of its centre, and its neighbour's centre is 1.92 MHz away. Closing the
// notch needs spacing below 1.2 MHz, i.e. more than 50% overlap.
func TestNoStepCoversAnotherStepsCentre(t *testing.T) {
	const sampleRate = 2_400_000.0
	const spacing = sampleRate * 0.8 // plan_sweep's `usable`

	centres := make([]float64, 14)
	for i := range centres {
		centres[i] = 902_000_000 + spacing/2 + float64(i)*spacing
	}

	for i, c := range centres {
		for j, other := range centres {
			if i == j {
				continue
			}
			if math.Abs(c-other) <= sampleRate/2 {
				t.Fatalf("step %d's centre (%.3f MHz) falls inside step %d (%.3f MHz +/- 1.2 MHz); "+
					"the notch coverage claim would hold and Stitch's blind cells are wrong",
					i, c/1e6, j, other/1e6)
			}
		}
	}
}

// The overlap that does exist: a frequency in the rolled-off edge of one step
// sits nearer the centre of the next, and max-hold takes the better reading
// rather than averaging a good one with a rolled-off one.
func TestStitchTakesTheBetterOfTwoOverlappingReadings(t *testing.T) {
	// 1.92 MHz apart, as plan_sweep spaces them.
	a := step(915_000_000, 1024, -90)
	b := step(916_920_000, 1024, -90)

	// 916.0 MHz: in step A's rolled-off outer fifth, well inside step B.
	const hz = 916_000_000.0
	aBin := int(math.Round((hz - a.FirstBinHz) / a.BinWidthHz))
	bBin := int(math.Round((hz - b.FirstBinHz) / b.BinWidthHz))
	a.BinsDBFS[aBin] = -74 // attenuated by the passband edge
	b.BinsDBFS[bBin] = -62 // the honest reading

	tr := Stitch(doc(a, b), 600)

	c := cellFor(tr, hz)
	if tr.DBFS[c] == nil {
		t.Fatal("both steps cover 916 MHz; it must not be blind")
	}
	if got := *tr.DBFS[c]; math.Abs(got-(-62)) > 0.5 {
		t.Fatalf("got %.1f dBFS, want -62: max-hold must keep the un-attenuated reading", got)
	}
}

// Every step centre stays blind, and that is the correct outcome rather than a
// gap to be filled. A renderer that joins across one draws a level nothing
// measured.
func TestStitchLeavesEveryStepCentreBlind(t *testing.T) {
	a := step(915_000_000, 1024, -70)
	b := step(916_920_000, 1024, -70)
	// The LO, as a zero-IF receiver reports it, in both steps.
	for i := 509; i < 516; i++ {
		a.BinsDBFS[i] = -55
		b.BinsDBFS[i] = -55
	}

	tr := Stitch(doc(a, b), 900)

	for _, centre := range []float64{915_000_000, 916_920_000} {
		c := cellFor(tr, centre)
		if tr.DBFS[c] != nil {
			t.Fatalf("%.3f MHz reported %.1f dBFS; that is the receiver's own LO",
				centre/1e6, *tr.DBFS[c])
		}
	}
	for i, v := range tr.DBFS {
		if v != nil && *v > -60 {
			t.Fatalf("cell %d reported %.1f dBFS; the LO leaked into the trace", i, *v)
		}
	}
}

// Max-hold, not mean. A control-link burst occupies a couple of bins out of a
// thousand; averaging it into a cell with its neighbours is exactly the
// operation that hides the only thing worth seeing.
func TestStitchDecimatesByMaxHold(t *testing.T) {
	s := step(915_000_000, 1024, -90)
	s.BinsDBFS[100] = -40

	tr := Stitch(doc(s), 64)

	peak := math.Inf(-1)
	for _, v := range tr.DBFS {
		if v != nil && *v > peak {
			peak = *v
		}
	}
	if math.Abs(peak-(-40)) > 0.01 {
		t.Fatalf("peak survived decimation as %.1f dBFS, want -40 (mean-decimation would read about -89)", peak)
	}
}

// A gap between steps is unmeasured spectrum, and must stay nil. Filling it
// would draw a floor across a frequency range the radio never tuned to.
func TestStitchLeavesAGapBetweenDistantStepsBlind(t *testing.T) {
	a := step(900_000_000, 256, -70)
	b := step(920_000_000, 256, -70)

	tr := Stitch(doc(a, b), 400)

	c := cellFor(tr, 910_000_000)
	if c < 0 || c >= len(tr.DBFS) {
		t.Fatalf("910 MHz fell outside the trace (%d cells)", len(tr.DBFS))
	}
	if tr.DBFS[c] != nil {
		t.Fatalf("910 MHz reported %.1f dBFS; no step covered it", *tr.DBFS[c])
	}
	if tr.Blind < 100 {
		t.Fatalf("blind count %d; the 17.6 MHz gap should dominate the trace", tr.Blind)
	}
}

// ism_433 is one 2.4 MHz step inside a 1.74 MHz band, so the radio measures
// past both band edges. Reporting the nominal band would throw that away.
func TestStitchSpansWhatWasMeasuredNotWhatWasAskedFor(t *testing.T) {
	d := doc(step(433_920_000, 1024, -70))
	d.StartHz, d.StopHz = 433_050_000, 434_790_000

	tr := Stitch(d, 512)

	if tr.StartHz >= float64(d.StartHz) {
		t.Fatalf("trace starts at %.0f Hz, but the step measured from %.0f", tr.StartHz, 433_920_000-1_200_000.0)
	}
	if tr.StopHz <= float64(d.StopHz) {
		t.Fatalf("trace stops at %.0f Hz, below what the step measured", tr.StopHz)
	}
}

// Asking for more cells than there are bins produces gaps that look like a
// broken receiver rather than an over-eager request.
func TestStitchNeverGoesFinerThanTheMeasurement(t *testing.T) {
	tr := Stitch(doc(step(915_000_000, 256, -70)), MaxTraceWidth)

	if len(tr.DBFS) > 256 {
		t.Fatalf("%d cells from 256 bins; the trace was upsampled", len(tr.DBFS))
	}
	// One cell per bin at this width, so the only blind cells are the DC guard
	// itself: 3 either side plus DC. More than that means cells fell between
	// bins, which is the upsampling this clamp exists to prevent.
	if tr.Blind != 7 {
		t.Fatalf("%d blind cells, want the 7-bin DC guard and nothing else", tr.Blind)
	}
}

func TestStitchOfAnEmptySweepIsEmptyNotAPanic(t *testing.T) {
	tr := Stitch(Doc{Band: "test"}, 100)
	if len(tr.DBFS) != 0 {
		t.Fatalf("got %d cells from a sweep with no steps", len(tr.DBFS))
	}
}

func TestPeakIsTheStrongestAcrossEveryStep(t *testing.T) {
	hz1, db1 := 903_000_000.0, -61.0
	hz2, db2 := 907_000_000.0, -48.0
	d := Doc{Steps: []DocStep{
		{PeakHz: &hz1, PeakDBFS: &db1},
		{PeakHz: &hz2, PeakDBFS: &db2},
		{}, // a step that read short
	}}

	hz, db := d.Peak()
	if db == nil || *db != db2 || hz == nil || *hz != hz2 {
		t.Fatalf("got %v %v, want the -48 dBFS peak at 907 MHz", hz, db)
	}
}

func TestPeakOfAnUnmeasuredSweepIsNilNotZero(t *testing.T) {
	hz, db := Doc{Steps: []DocStep{{}}}.Peak()
	if hz != nil || db != nil {
		t.Fatalf("got %v %v; 0 dBFS is a full-scale signal, not a missing reading", hz, db)
	}
}

// The Go and Rust guard ranges have to agree bin for bin. They are computed
// independently on both sides, and a one-bin disagreement either masks real
// spectrum or lets the LO through.
func TestGuardRangeMatchesTheSensorsOwn(t *testing.T) {
	// The case asserted in sweepdoc.rs: 1024 bins, guard 3.
	lo, hi := guardRange(1024, 3)
	if lo != 509 || hi != 516 {
		t.Fatalf("guard [%d,%d), want [509,516) to match SweepStepDoc::dc_guard_range", lo, hi)
	}
	if lo, hi := guardRange(0, 3); lo != 0 || hi != 0 {
		t.Fatalf("empty step guard [%d,%d), want [0,0)", lo, hi)
	}
	if lo, hi := guardRange(4, 100); lo != 0 || hi != 4 {
		t.Fatalf("oversized guard [%d,%d), want the whole step clamped to [0,4)", lo, hi)
	}
}

// The api parses what the sensor prints. Both sides own half of this contract,
// so the shape is asserted here against the literal document the Rust test
// round-trips.
func TestParseDocReadsTheSensorsShape(t *testing.T) {
	raw := []byte(`{"band":"ism_915","class":"E","note":"ELRS 900","start_hz":902000000,
	"stop_hz":928000000,"sample_rate":2400000,"fft_size":1024,"dc_guard_bins":3,
	"gain_tenth_db":200,"noise_floor_dbfs":-70.5,"threshold_dbfs":-60.5,
	"threshold_over_floor_db":10.0,"short_reads":[903000000],
	"steps":[{"center_hz":902960000,"first_bin_hz":901760000,"bin_width_hz":2343.75,
	"bins_dbfs":[-70.5,-71.0],"peak_hz":902341000,"peak_dbfs":-65.5}]}`)

	d, err := ParseDoc(raw)
	if err != nil {
		t.Fatalf("ParseDoc: %v", err)
	}
	if d.Band != "ism_915" || d.DCGuardBins != 3 || d.FFTSize != 1024 {
		t.Fatalf("band=%q guard=%d fft=%d", d.Band, d.DCGuardBins, d.FFTSize)
	}
	if d.NoiseFloorDBFS == nil || *d.NoiseFloorDBFS != -70.5 {
		t.Fatalf("noise floor %v", d.NoiseFloorDBFS)
	}
	if len(d.Steps) != 1 || len(d.Steps[0].BinsDBFS) != 2 {
		t.Fatalf("steps %+v", d.Steps)
	}
	if len(d.ShortReads) != 1 || d.ShortReads[0] != 903_000_000 {
		t.Fatalf("short reads %v", d.ShortReads)
	}
}

// A band with no floor serialises its floor as null. Substituting 0 would
// report a full-scale signal across the band -- the loudest possible way to
// say "we did not measure".
func TestParseDocKeepsAnUnmeasuredFloorNil(t *testing.T) {
	d, err := ParseDoc([]byte(`{"band":"ism_433","noise_floor_dbfs":null,"steps":[]}`))
	if err != nil {
		t.Fatalf("ParseDoc: %v", err)
	}
	if d.NoiseFloorDBFS != nil {
		t.Fatalf("got %v, want nil", *d.NoiseFloorDBFS)
	}
}

func TestParseDocRefusesOutputThatIsNotASweep(t *testing.T) {
	for _, raw := range []string{``, `not json`, `{}`, `{"steps":[]}`} {
		if _, err := ParseDoc([]byte(raw)); err == nil {
			t.Fatalf("accepted %q as a sweep", raw)
		}
	}
}

// A nil in the trace has to survive JSON as null, not as 0.
func TestTraceSerialisesBlindCellsAsNull(t *testing.T) {
	tr := Stitch(doc(step(915_000_000, 256, -70)), 64)
	tr.DBFS[0] = nil

	b, err := json.Marshal(tr)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !containsSub(string(b), `"dbfs":[null,`) {
		t.Fatalf("blind cell did not serialise as null: %s", truncate(string(b), 120))
	}
}

func containsSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

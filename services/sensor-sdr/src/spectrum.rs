//! Power spectrum from IQ samples.
//!
//! HARD CONSTRAINT, same as sweep.rs: this measures ENERGY and nothing else.
//! A power spectrum says a transmission exists, how wide it is and how strong;
//! it recovers no symbol, no payload and no video. That distinction is legal,
//! not stylistic -- see docs/research/06-legal-and-ethics.md. Nothing here may
//! grow a demodulator.

use num_complex::Complex;
use rustfft::FftPlanner;

/// One measured slice of spectrum, ordered low frequency to high.
pub struct Spectrum {
    pub center_hz: u64,
    pub sample_rate: u32,
    /// Power per bin in dBFS. Index 0 is the lowest frequency in the slice, so
    /// this is already fftshifted -- a caller reading it left to right is
    /// reading the band left to right, which is the only ordering a sweep or a
    /// chart ever wants.
    pub bins_db: Vec<f32>,
}

impl Spectrum {
    /// Centre frequency of a bin.
    pub fn bin_hz(&self, index: usize) -> f64 {
        let n = self.bins_db.len() as f64;
        let offset = index as f64 - n / 2.0;
        self.center_hz as f64 + offset * (self.sample_rate as f64 / n)
    }

    /// Strongest bin and its power, or None for an empty spectrum.
    ///
    /// Includes the centre. Use [`Spectrum::peak_excluding_dc`] for anything
    /// that decides whether a signal is present.
    pub fn peak(&self) -> Option<(usize, f32)> {
        self.bins_db
            .iter()
            .enumerate()
            .fold(None, |best, (i, &db)| match best {
                Some((_, b)) if b >= db => best,
                _ => Some((i, db)),
            })
    }

    /// Strongest bin ignoring a guard band around the centre.
    ///
    /// The RTL-SDR is a zero-IF receiver: its own local oscillator leaks into
    /// the mixer and lands at exactly the tuned frequency, so every slice has a
    /// spike at DC that belongs to the radio rather than to the air. Measured on
    /// the unit sweeping 902-928 MHz, the first version of this sweep reported a
    /// peak at precisely the centre of all fourteen steps, ~12 dB over the
    /// floor -- fourteen confident detections of the receiver looking at itself.
    ///
    /// A guard of a few bins rather than one: the spike smears across
    /// neighbours through window leakage and any residual IQ imbalance.
    ///
    /// The cost is a genuine blind notch a few kHz wide at each step centre,
    /// and it stays blind. `plan_sweep`'s 20% overlap does NOT cover it: with
    /// centres 1.92 MHz apart and each step spanning 2.4 MHz, what gets measured
    /// twice is the outer 0.48 MHz of each step -- the rolled-off edges, which
    /// is what that overlap is for. No step contains another step's centre, at
    /// any overlap below 50%.
    ///
    /// What makes the notch acceptable is its width, not any coverage. At 2.4
    /// MSPS with a 1024-point transform it is ~16 kHz, recurring every 1.92 MHz:
    /// 0.8% of the band. Nothing this sensor exists to notice is that narrow --
    /// ELRS, Crossfire and analog FPV all occupy 250 kHz or more, so a real
    /// emitter straddles a notch rather than hiding in one. A sweeper that
    /// closed the notch would need better than 50% overlap, which doubles the
    /// step count and doubles the time the radio is taken from dump1090.
    ///
    /// Consumers must render the notch as unmeasured rather than as a level.
    /// The api's stitcher does (internal/spectrum.Stitch), and its tests assert
    /// the arithmetic above rather than trusting this comment.
    pub fn peak_excluding_dc(&self, guard_bins: usize) -> Option<(usize, f32)> {
        let n = self.bins_db.len();
        if n == 0 {
            return None;
        }
        let dc = n / 2;
        let low = dc.saturating_sub(guard_bins);
        let high = (dc + guard_bins).min(n - 1);

        self.bins_db
            .iter()
            .enumerate()
            .filter(|(i, _)| *i < low || *i > high)
            .fold(None, |best, (i, &db)| match best {
                Some((_, b)) if b >= db => best,
                _ => Some((i, db)),
            })
    }
}

/// Bins either side of centre to ignore when looking for real energy.
///
/// At 2.4 MSPS with a 1024-point transform each bin is ~2.3 kHz, so this is a
/// notch about 16 kHz wide -- narrow against the 250 kHz-plus occupied
/// bandwidth of anything this sensor is meant to notice.
pub const DC_GUARD_BINS: usize = 3;

/// Hann window.
///
/// Without it a carrier sitting between two bin centres smears across the whole
/// slice -- rectangular-window sidelobes fall off at only 13 dB, which on an
/// 8-bit ADC is enough to bury everything else in the band and produce a noise
/// floor estimate that is really one strong emitter.
pub fn hann(n: usize) -> Vec<f32> {
    if n <= 1 {
        return vec![1.0; n];
    }
    (0..n)
        .map(|i| {
            let x = std::f32::consts::PI * 2.0 * i as f32 / (n - 1) as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect()
}

/// Averaged power spectrum over as many whole `size`-sample segments as `iq`
/// holds (Welch's method, no overlap).
///
/// Averaging rather than one transform because a single FFT of noise has a
/// standard deviation as large as its mean: a noise floor read off one segment
/// moves several dB between reads, and every threshold derived from it moves
/// with it. Averaging N segments divides that variance by N and costs only
/// samples, which the radio produces faster than the band can be swept.
///
/// Returns None when `iq` holds less than one full segment -- a partial
/// transform would be zero-padded, which narrows the apparent bandwidth of
/// everything in the slice and is worse than admitting there was no reading.
pub fn power_spectrum(
    iq: &[Complex<f32>],
    center_hz: u64,
    sample_rate: u32,
    size: usize,
) -> Option<Spectrum> {
    if size == 0 || iq.len() < size {
        return None;
    }

    let window = hann(size);
    // Coherent gain, so windowing does not shift the measured level of a tone.
    let coherent_gain: f32 = window.iter().sum::<f32>() / size as f32;

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(size);

    let segments = iq.len() / size;
    let mut accum = vec![0.0f32; size];
    let mut scratch = vec![Complex::new(0.0, 0.0); size];

    for segment in 0..segments {
        let start = segment * size;
        for (i, slot) in scratch.iter_mut().enumerate() {
            *slot = iq[start + i] * window[i];
        }
        fft.process(&mut scratch);
        for (i, value) in scratch.iter().enumerate() {
            accum[i] += value.norm_sqr();
        }
    }

    // Normalise by segments, transform length and window gain so the result is
    // dBFS: a full-scale tone reads 0 dB whatever the FFT size.
    let norm = (segments as f32) * (size as f32).powi(2) * coherent_gain.powi(2);
    let mut db: Vec<f32> = accum
        .iter()
        .map(|&p| 10.0 * (p / norm).max(f32::MIN_POSITIVE).log10())
        .collect();

    fftshift(&mut db);

    Some(Spectrum {
        center_hz,
        sample_rate,
        bins_db: db,
    })
}

/// Rotate DC from index 0 to the middle, so the slice reads in frequency order.
fn fftshift(bins: &mut [f32]) {
    let half = bins.len() / 2;
    bins.rotate_left(half);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A complex tone at a known offset, sampled coherently so it lands exactly
    /// on a bin. If the shift, the bin mapping or the sign of the offset is
    /// wrong, this points at the wrong frequency -- which in a sweep means
    /// reporting a detection in the wrong part of the band.
    fn tone(size: usize, bin_offset: i32) -> Vec<Complex<f32>> {
        (0..size)
            .map(|i| {
                let phase = 2.0 * std::f32::consts::PI * bin_offset as f32 * i as f32 / size as f32;
                Complex::new(phase.cos(), phase.sin())
            })
            .collect()
    }

    #[test]
    fn finds_a_tone_in_the_bin_its_frequency_says() {
        let size = 1024;
        let sample_rate = 2_400_000u32;
        let center = 915_000_000u64;

        for offset in [-256i32, -1, 0, 1, 100, 256] {
            let s = power_spectrum(&tone(size, offset), center, sample_rate, size).unwrap();
            let (peak_bin, _) = s.peak().unwrap();

            let expected_hz = center as f64 + offset as f64 * (sample_rate as f64 / size as f64);
            let measured_hz = s.bin_hz(peak_bin);
            let bin_width = sample_rate as f64 / size as f64;

            assert!(
                (measured_hz - expected_hz).abs() < bin_width,
                "offset {offset}: peak at {measured_hz} Hz, expected {expected_hz} Hz",
            );
        }
    }

    /// DC lands in the middle after the shift, which is what makes bins_db
    /// readable as "left to right across the band".
    #[test]
    fn dc_sits_in_the_middle_after_the_shift() {
        let size = 256;
        let s = power_spectrum(&tone(size, 0), 915_000_000, 2_400_000, size).unwrap();
        assert_eq!(s.peak().unwrap().0, size / 2);
        assert_eq!(s.bin_hz(size / 2) as u64, 915_000_000);
    }

    /// A full-scale tone reads about 0 dBFS regardless of transform length --
    /// otherwise a threshold in dB means something different at every FFT size.
    #[test]
    fn a_full_scale_tone_reads_near_zero_dbfs_at_any_size() {
        for size in [256usize, 1024, 4096] {
            let s = power_spectrum(&tone(size, 10), 915_000_000, 2_400_000, size).unwrap();
            let (_, peak_db) = s.peak().unwrap();
            assert!(
                peak_db.abs() < 1.0,
                "size {size}: peak {peak_db} dBFS, expected about 0",
            );
        }
    }

    /// Averaging must not change the level, only the variance.
    #[test]
    fn averaging_segments_does_not_shift_the_level() {
        let size = 512;
        let one = tone(size, 40);
        let many: Vec<_> = std::iter::repeat_n(one.clone(), 8).flatten().collect();

        let a = power_spectrum(&one, 915_000_000, 2_400_000, size).unwrap();
        let b = power_spectrum(&many, 915_000_000, 2_400_000, size).unwrap();

        assert_eq!(a.peak().unwrap().0, b.peak().unwrap().0);
        assert!((a.peak().unwrap().1 - b.peak().unwrap().1).abs() < 0.01);
    }

    /// Less than one full segment is no reading, not a zero-padded one.
    #[test]
    fn refuses_a_buffer_shorter_than_one_transform() {
        assert!(power_spectrum(&tone(100, 3), 915_000_000, 2_400_000, 1024).is_none());
        assert!(power_spectrum(&[], 915_000_000, 2_400_000, 1024).is_none());
    }

    /// The bug real hardware found: a zero-IF receiver puts its own LO at the
    /// tuned frequency, and a sweep that trusts the raw peak reports a
    /// detection at the centre of every step it ever takes.
    #[test]
    fn ignores_the_receiver_s_own_dc_spike() {
        let size = 1024;
        // A DC spike far above a weak real signal off to one side.
        let mut iq: Vec<Complex<f32>> = tone(size, 0).iter().map(|c| c * 1.0).collect();
        for (i, sample) in iq.iter_mut().enumerate() {
            let phase = 2.0 * std::f32::consts::PI * 200.0 * i as f32 / size as f32;
            *sample += Complex::new(phase.cos(), phase.sin()) * 0.05;
        }

        let s = power_spectrum(&iq, 915_000_000, 2_400_000, size).unwrap();

        // The raw peak is the radio looking at itself.
        assert_eq!(s.peak().unwrap().0, size / 2);

        // Excluding the guard finds the signal that is actually on the air.
        let (bin, _) = s.peak_excluding_dc(DC_GUARD_BINS).unwrap();
        assert_eq!(bin, size / 2 + 200, "should find the off-centre tone");
    }

    /// The guard must not swallow a signal sitting just outside it.
    #[test]
    fn keeps_a_signal_immediately_beyond_the_guard() {
        let size = 256;
        let offset = (DC_GUARD_BINS + 1) as i32;
        let s = power_spectrum(&tone(size, offset), 915_000_000, 2_400_000, size).unwrap();
        assert_eq!(
            s.peak_excluding_dc(DC_GUARD_BINS).unwrap().0,
            size / 2 + offset as usize
        );
    }

    #[test]
    fn hann_is_symmetric_and_zero_at_the_edges() {
        let w = hann(64);
        assert!(w[0].abs() < 1e-6);
        assert!(w[63].abs() < 1e-6);
        assert!((w[32] - 1.0).abs() < 0.01);
        for i in 0..32 {
            assert!((w[i] - w[63 - i]).abs() < 1e-6, "asymmetric at {i}");
        }
    }
}

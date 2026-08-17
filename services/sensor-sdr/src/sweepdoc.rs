//! The wire shape of a completed sweep.
//!
//! HARD CONSTRAINT, inherited from sweep.rs and spectrum.rs: every number here
//! is an energy measurement. A power spectrum says a transmission exists, where
//! it is and how strong; it recovers no symbol and no payload. Serialising it
//! does not change that, and nothing added to this document may.
//!
//! This exists because `sweep` used to end at a terminal. A measurement nobody
//! can store, chart or compare against last week is a measurement that only
//! exists while someone is watching the scrollback -- which is the same failure
//! the telemetry table was added to fix. The api consumes this document.
//!
//! Kept free of the `rtlsdr` feature deliberately: the shape is checked by tests
//! and by the Go side on any machine, not only on one with a radio attached.

use serde::{Deserialize, Serialize};

/// A whole band, measured once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepDoc {
    pub band: String,
    /// Detection class this band would produce, from `BAND_PLANS`.
    pub class: String,
    pub note: String,
    pub start_hz: u64,
    pub stop_hz: u64,
    pub sample_rate: u32,
    pub fft_size: usize,
    /// Bins either side of each step centre that carry the receiver's own LO
    /// rather than the air. Consumers must render these as absent, not as a
    /// level -- see [`SweepStepDoc::bins_dbfs`].
    pub dc_guard_bins: usize,
    /// Tuner gain in tenths of a dB, as librtlsdr takes it.
    pub gain_tenth_db: i32,
    /// Median across every bin of every step.
    pub noise_floor_dbfs: Option<f32>,
    /// The floor plus [`SweepDoc::threshold_over_floor_db`]. Above this is
    /// "something is there", not "something is a drone".
    pub threshold_dbfs: Option<f32>,
    pub threshold_over_floor_db: f32,
    pub steps: Vec<SweepStepDoc>,
    /// Steps that returned too few samples to transform. Non-empty means the
    /// band has holes in it and the trace should say so rather than closing
    /// over them.
    pub short_reads: Vec<u64>,
}

/// One tune step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepStepDoc {
    pub center_hz: u64,
    /// Frequency of `bins_dbfs[0]`. Bin *i* sits at `first_bin_hz + i *
    /// bin_width_hz`, which is why no per-bin frequency array is sent.
    pub first_bin_hz: f64,
    pub bin_width_hz: f64,
    /// Power per bin in dBFS, lowest frequency first.
    ///
    /// The middle `2 * dc_guard_bins + 1` entries are the radio looking at
    /// itself. They are transmitted as measured rather than blanked, because
    /// blanking here would leave a consumer unable to tell a guard band from a
    /// genuine null -- but a consumer that plots them without knowing that is
    /// plotting a signal that is not on the air. The api's stitcher covers each
    /// notch with the overlapping neighbour step.
    pub bins_dbfs: Vec<f32>,
    /// Strongest bin outside the DC guard, if the step measured at all.
    pub peak_hz: Option<f64>,
    pub peak_dbfs: Option<f32>,
}

/// Round to 0.1 dB, which is finer than this receiver can actually resolve.
///
/// Not cosmetic. `fpv_1g2` is 146 steps of 1024 bins, and at full f32 precision
/// that serialises to about 1.5 MB per sweep -- stored, then shipped to a
/// browser. The extra digits are noise: an 8-bit ADC averaged over eight
/// segments does not distinguish -70.53 dBFS from -70.5, and the +10 dB
/// detection threshold is two orders of magnitude coarser than either.
pub fn round_db(db: f32) -> f32 {
    (db * 10.0).round() / 10.0
}

impl SweepStepDoc {
    /// Half-open index range of the DC guard within `bins_dbfs`.
    ///
    /// Returned rather than applied, for the reason on `bins_dbfs`: a consumer
    /// has to be able to distinguish "the receiver is blind here" from "there
    /// is nothing here", and those two look identical once the samples are
    /// gone. Nor does the neighbouring step cover the guard at the overlap
    /// `plan_sweep` uses -- see `Spectrum::peak_excluding_dc` for why that is
    /// tolerable and why closing it would not be.
    pub fn dc_guard_range(&self, guard_bins: usize) -> (usize, usize) {
        let n = self.bins_dbfs.len();
        if n == 0 {
            return (0, 0);
        }
        let dc = n / 2;
        (dc.saturating_sub(guard_bins), (dc + guard_bins + 1).min(n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(bins: usize) -> SweepStepDoc {
        SweepStepDoc {
            center_hz: 915_000_000,
            first_bin_hz: 915_000_000.0 - 1_200_000.0,
            bin_width_hz: 2_400_000.0 / bins as f64,
            bins_dbfs: vec![-70.0; bins],
            peak_hz: None,
            peak_dbfs: None,
        }
    }

    /// The guard has to straddle the same centre bin that `fftshift` puts DC in,
    /// or the api masks the wrong bins and hides real spectrum while plotting
    /// the LO.
    #[test]
    fn guard_range_straddles_the_centre_bin() {
        let s = step(1024);
        let (low, high) = s.dc_guard_range(3);
        assert_eq!((low, high), (509, 516));
        assert!(low <= 512 && 512 < high, "centre bin must be inside");
        assert_eq!(high - low, 7, "guard_bins either side, plus DC itself");
    }

    #[test]
    fn guard_range_is_clamped_and_empty_for_an_empty_step() {
        assert_eq!(step(0).dc_guard_range(3), (0, 0));
        let s = step(4);
        let (low, high) = s.dc_guard_range(100);
        assert_eq!((low, high), (0, 4));
    }

    /// The api parses this document. A field renamed on one side and not the
    /// other is a silent wire mismatch, which is the failure `schemas/` exists
    /// to prevent -- so the round trip is checked here too.
    #[test]
    fn survives_a_json_round_trip() {
        let doc = SweepDoc {
            band: "ism_915".into(),
            class: "E".into(),
            note: "ELRS 900".into(),
            start_hz: 902_000_000,
            stop_hz: 928_000_000,
            sample_rate: 2_400_000,
            fft_size: 1024,
            dc_guard_bins: 3,
            gain_tenth_db: 200,
            noise_floor_dbfs: Some(-70.5),
            threshold_dbfs: Some(-60.5),
            threshold_over_floor_db: 10.0,
            steps: vec![step(8)],
            short_reads: vec![903_000_000],
        };

        let json = serde_json::to_string(&doc).unwrap();
        let back: SweepDoc = serde_json::from_str(&json).unwrap();

        assert_eq!(back.band, "ism_915");
        assert_eq!(back.steps.len(), 1);
        assert_eq!(back.steps[0].bins_dbfs.len(), 8);
        assert_eq!(back.short_reads, vec![903_000_000]);
        assert_eq!(back.noise_floor_dbfs, Some(-70.5));
    }

    /// Rounding must not move a bin across the detection threshold by more than
    /// the rounding step itself -- a peak reported 0.5 dB low is a peak that can
    /// vanish from the "above threshold" list.
    #[test]
    fn rounding_stays_within_half_a_step() {
        for db in [-70.5372, -0.0001, -123.456, 0.0, -60.4999] {
            assert!(
                (round_db(db) - db).abs() <= 0.05001,
                "{db} rounded to {}",
                round_db(db)
            );
        }
        assert_eq!(round_db(-70.537), -70.5);
        // Half rounds away from zero, so a negative tie goes down. Which way a
        // tie falls does not matter here; that it is deterministic does, or two
        // sweeps of identical spectrum would not compare equal.
        assert_eq!(round_db(-70.55), -70.6);
    }

    /// A band nothing was measured in still has to serialise: `null` is the
    /// honest answer for a floor that could not be estimated, and 0 dBFS -- a
    /// full-scale signal -- is the most dangerous possible substitute.
    #[test]
    fn an_unmeasured_floor_serialises_as_null_not_zero() {
        let doc = SweepDoc {
            band: "ism_433".into(),
            class: "E".into(),
            note: String::new(),
            start_hz: 433_050_000,
            stop_hz: 434_790_000,
            sample_rate: 2_400_000,
            fft_size: 1024,
            dc_guard_bins: 3,
            gain_tenth_db: 200,
            noise_floor_dbfs: None,
            threshold_dbfs: None,
            threshold_over_floor_db: 10.0,
            steps: vec![],
            short_reads: vec![],
        };
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"noise_floor_dbfs\":null"), "{json}");
        assert!(json.contains("\"threshold_dbfs\":null"), "{json}");
    }
}

//! Band sweep and energy detection.
//!
//! HARD CONSTRAINT: this module characterises signal ENVELOPES only -- power,
//! bandwidth, burst cadence, duty cycle. It must never demodulate payload or
//! video content. Detecting that a transmission exists is legally distinct from
//! intercepting what it carries. See docs/research/06-legal-and-ethics.md.
//!
//! Any future change here that recovers content is a legal problem, not just a
//! scope change.

use crate::source::RTLSDR_STABLE_SAMPLE_RATE;

/// A contiguous span to sweep in 2.4 MHz steps.
#[derive(Debug, Clone)]
pub struct BandPlan {
    pub name: &'static str,
    pub start_hz: u64,
    pub stop_hz: u64,
    /// Detection class this band produces (see README).
    pub class: char,
    pub note: &'static str,
}

/// Bands worth sweeping with an RTL-SDR, in priority order.
///
/// Note what is absent: 2.4 GHz and 5.8 GHz. Those are where DJI lives, and they
/// are unreachable. The value here is the 900 MHz band -- aircraft flying ELRS or
/// Crossfire broadcast no Remote ID at all, so this is the ONLY sensor that sees
/// them.
pub const BAND_PLANS: &[BandPlan] = &[
    BandPlan {
        name: "ism_915",
        start_hz: 902_000_000,
        stop_hz: 928_000_000,
        class: 'E',
        note: "ELRS 900, TBS Crossfire, RFD900. Heavy clutter: smart meters, \
               Meshtastic, LoRaWAN. Cadence analysis, not raw energy, makes this usable.",
    },
    BandPlan {
        name: "ism_868",
        start_hz: 863_000_000,
        stop_hz: 870_000_000,
        class: 'E',
        note: "EU Crossfire / ELRS 868",
    },
    BandPlan {
        name: "ism_433",
        start_hz: 433_050_000,
        stop_hz: 434_790_000,
        class: 'E',
        note: "Legacy MAVLink telemetry, ELRS 433. Fits in a single 2.4 MHz tune.",
    },
    BandPlan {
        name: "fpv_1g2",
        start_hz: 1_080_000_000,
        stop_hz: 1_360_000_000,
        class: 'F',
        note: "Analog FPV video downlink. Continuous transmission while flying, \
               so sustained occupancy is itself the signature.",
    },
];

/// Control-link burst rates that distinguish drone links from ISM clutter.
///
/// ELRS and Crossfire run at fixed packet rates. A smart meter or Meshtastic node
/// does not produce a metronomic 50/100/200 Hz burst train, which is why cadence
/// beats energy for classification here.
pub const CONTROL_LINK_RATES_HZ: &[f32] = &[50.0, 100.0, 150.0, 200.0, 250.0, 333.0, 500.0];

#[derive(Debug, Clone)]
pub struct SweepStep {
    pub center_hz: u64,
    pub bandwidth_hz: u32,
}

/// Split a band into overlapping tune steps.
///
/// Overlap matters: the outer ~20% of an RTL-SDR's passband rolls off, so
/// abutting steps exactly would leave blind notches at every boundary.
pub fn plan_sweep(band: &BandPlan, overlap: f32) -> Vec<SweepStep> {
    let usable = (RTLSDR_STABLE_SAMPLE_RATE as f32 * (1.0 - overlap)) as u64;
    let mut steps = Vec::new();
    let mut center = band.start_hz + usable / 2;
    while center - usable / 2 < band.stop_hz {
        steps.push(SweepStep {
            center_hz: center,
            bandwidth_hz: RTLSDR_STABLE_SAMPLE_RATE,
        });
        center += usable;
    }
    steps
}

/// Rolling noise-floor estimate.
///
/// Thresholds must be derived from measurement, not guessed. The T7-equivalent
/// negative control (24 h with no drone activity) sets the operating point --
/// an unvalidated detector produces confident output nobody has checked.
pub struct NoiseFloor {
    samples: Vec<f32>,
    capacity: usize,
    idx: usize,
}

impl NoiseFloor {
    pub fn new(capacity: usize) -> Self {
        Self {
            samples: Vec::with_capacity(capacity),
            capacity,
            idx: 0,
        }
    }

    pub fn push(&mut self, power_db: f32) {
        if self.samples.len() < self.capacity {
            self.samples.push(power_db);
        } else {
            self.samples[self.idx] = power_db;
            self.idx = (self.idx + 1) % self.capacity;
        }
    }

    /// Median is deliberate: the mean is dragged upward by the very signals we
    /// are trying to detect above the floor.
    pub fn median(&self) -> Option<f32> {
        if self.samples.is_empty() {
            return None;
        }
        let mut sorted = self.samples.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Some(sorted[sorted.len() / 2])
    }

    pub fn threshold(&self, margin_db: f32) -> Option<f32> {
        self.median().map(|m| m + margin_db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep_covers_the_whole_band() {
        let band = &BAND_PLANS[0];
        let steps = plan_sweep(band, 0.2);
        assert!(!steps.is_empty());
        let first = steps.first().unwrap();
        let last = steps.last().unwrap();
        assert!(first.center_hz - (first.bandwidth_hz as u64 / 2) <= band.start_hz);
        assert!(last.center_hz + (last.bandwidth_hz as u64 / 2) >= band.stop_hz);
    }

    #[test]
    fn ism_433_fits_a_single_tune() {
        let band = BAND_PLANS.iter().find(|b| b.name == "ism_433").unwrap();
        assert_eq!(plan_sweep(band, 0.2).len(), 1);
    }

    #[test]
    fn noise_floor_uses_median_not_mean() {
        let mut nf = NoiseFloor::new(16);
        for _ in 0..15 {
            nf.push(-100.0);
        }
        nf.push(-20.0); // a strong signal must not move the floor
        assert!(nf.median().unwrap() < -95.0);
    }

    /// Every band in the plan must be reachable by the hardware.
    #[test]
    fn all_bands_are_within_tuner_range() {
        for band in BAND_PLANS {
            assert!(
                band.stop_hz <= crate::source::RTLSDR_MAX_HZ,
                "{}",
                band.name
            );
            assert!(
                band.start_hz >= crate::source::RTLSDR_MIN_HZ,
                "{}",
                band.name
            );
        }
    }
}

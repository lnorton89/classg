//! SDR abstraction.
//!
//! `sensor-sdr` talks to this trait, never to librtlsdr directly. Adding a HackRF
//! later (the only path to real OcuSync DroneID decode) is then a new impl rather
//! than a rewrite -- see ADR-0004.

use std::fmt;

/// Hard ceiling of the RTL-SDR V4's R828D tuner.
///
/// This constant is why the SDR cannot detect DJI drones: OcuSync lives at
/// 2.4/5.8 GHz, far above it. Enforced in code so the limitation surfaces as a
/// clear error rather than as mysteriously empty spectrum.
pub const RTLSDR_MAX_HZ: u64 = 1_766_000_000;
pub const RTLSDR_MIN_HZ: u64 = 500_000;

/// 3.2 MSPS is spec; 2.4 MSPS is what actually runs without dropped samples.
pub const RTLSDR_STABLE_SAMPLE_RATE: u32 = 2_400_000;

#[derive(Debug)]
pub enum SdrError {
    /// Requested frequency is outside the device's tuning range.
    OutOfBand { requested_hz: u64, max_hz: u64 },
    /// USB read failed. Common and recoverable -- reopen the device.
    ReadFailed(String),
    DeviceNotFound,
    Config(String),
}

impl fmt::Display for SdrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SdrError::OutOfBand { requested_hz, max_hz } => write!(
                f,
                "{:.3} GHz is above this device's {:.3} GHz ceiling. \
                 If you are trying to receive DJI OcuSync (2.4/5.8 GHz), an RTL-SDR \
                 cannot do it at any gain or antenna -- see docs/architecture/adr/0004-rtlsdr-scope.md",
                *requested_hz as f64 / 1e9,
                *max_hz as f64 / 1e9
            ),
            SdrError::ReadFailed(m) => write!(f, "SDR read failed: {m}"),
            SdrError::DeviceNotFound => write!(
                f,
                "no SDR found. Check: dvb_usb_rtl28xxu blacklisted, udev rules installed, \
                 and the RTL-SDR Blog driver fork built (stock librtlsdr does not support the V4)"
            ),
            SdrError::Config(m) => write!(f, "SDR config error: {m}"),
        }
    }
}

impl std::error::Error for SdrError {}

/// Interleaved complex samples as delivered by the device.
pub struct SampleBuffer {
    pub iq: Vec<num_complex::Complex<f32>>,
    pub center_hz: u64,
    pub sample_rate: u32,
}

pub trait SdrSource: Send {
    fn open(index: u32) -> Result<Self, SdrError>
    where
        Self: Sized;

    fn min_hz(&self) -> u64;
    fn max_hz(&self) -> u64;

    fn set_center_freq(&mut self, hz: u64) -> Result<(), SdrError>;
    fn set_sample_rate(&mut self, sps: u32) -> Result<(), SdrError>;

    /// Manual gain. AGC is deliberately not exposed: with an 8-bit ADC (~48 dB of
    /// dynamic range) front-end overload from too much gain is the classic way to
    /// make weak signals disappear.
    fn set_gain(&mut self, tenths_db: i32) -> Result<(), SdrError>;

    fn read_samples(&mut self, count: usize) -> Result<SampleBuffer, SdrError>;

    fn check_tunable(&self, hz: u64) -> Result<(), SdrError> {
        if hz > self.max_hz() {
            return Err(SdrError::OutOfBand { requested_hz: hz, max_hz: self.max_hz() });
        }
        if hz < self.min_hz() {
            return Err(SdrError::Config(format!(
                "{hz} Hz is below this device's {} Hz floor",
                self.min_hz()
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeRtl;
    impl SdrSource for FakeRtl {
        fn open(_i: u32) -> Result<Self, SdrError> { Ok(FakeRtl) }
        fn min_hz(&self) -> u64 { RTLSDR_MIN_HZ }
        fn max_hz(&self) -> u64 { RTLSDR_MAX_HZ }
        fn set_center_freq(&mut self, _hz: u64) -> Result<(), SdrError> { Ok(()) }
        fn set_sample_rate(&mut self, _s: u32) -> Result<(), SdrError> { Ok(()) }
        fn set_gain(&mut self, _g: i32) -> Result<(), SdrError> { Ok(()) }
        fn read_samples(&mut self, _c: usize) -> Result<SampleBuffer, SdrError> {
            Err(SdrError::ReadFailed("fake".into()))
        }
    }

    /// The constraint that shapes the whole project, asserted in code.
    #[test]
    fn rejects_dji_frequencies_with_an_actionable_message() {
        let s = FakeRtl;
        for band in [2_437_000_000u64, 5_800_000_000u64] {
            let err = s.check_tunable(band).unwrap_err();
            assert!(matches!(err, SdrError::OutOfBand { .. }));
            assert!(err.to_string().contains("OcuSync"));
        }
    }

    #[test]
    fn accepts_in_band_targets() {
        let s = FakeRtl;
        for hz in [433_920_000u64, 915_000_000, 1_090_000_000, 1_575_420_000] {
            assert!(s.check_tunable(hz).is_ok(), "{hz} should be tunable");
        }
    }
}

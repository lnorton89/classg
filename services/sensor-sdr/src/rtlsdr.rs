//! `SdrSource` backed by a real RTL-SDR, over a hand-written FFI to librtlsdr.
//!
//! Behind the `rtlsdr` feature, which is off by default. That is not caution
//! about the code: the CI `rust` job installs no system packages, and a hard
//! link against librtlsdr would mean the crate no longer builds there at all.
//! Everything except this module compiles and tests without a radio or a
//! system library, exactly as before; `--features rtlsdr` is what a Pi build
//! adds.
//!
//! No `rtlsdr` crate. The published binding wraps stock librtlsdr, and the V4
//! needs the RTL-SDR Blog fork -- its R828D handling is the whole reason
//! [ADR-0004](../../../docs/architecture/adr/0004-rtlsdr-scope.md) specifies
//! that fork. Declaring the dozen functions this needs is smaller than a
//! dependency that would have to be patched anyway, and it is the same trade
//! `zmtp.rs` and `clock.rs` already make.
//!
//! HARD CONSTRAINT: this is a receiver. librtlsdr can transmit on nothing, and
//! no function below has a write path to the air. See
//! [06-legal-and-ethics](../../../docs/research/06-legal-and-ethics.md).

use std::ffi::c_void;
use std::os::raw::{c_char, c_int, c_uint};

use num_complex::Complex;

use crate::source::{
    SampleBuffer, SdrError, SdrSource, RTLSDR_MAX_HZ, RTLSDR_MIN_HZ, RTLSDR_STABLE_SAMPLE_RATE,
};

/// Opaque `rtlsdr_dev_t`. Never dereferenced on this side.
#[repr(C)]
struct RtlSdrDev {
    _private: [u8; 0],
}

#[link(name = "rtlsdr")]
extern "C" {
    fn rtlsdr_get_device_count() -> c_uint;
    fn rtlsdr_get_device_name(index: c_uint) -> *const c_char;
    fn rtlsdr_open(dev: *mut *mut RtlSdrDev, index: c_uint) -> c_int;
    fn rtlsdr_close(dev: *mut RtlSdrDev) -> c_int;
    fn rtlsdr_set_center_freq(dev: *mut RtlSdrDev, freq_hz: c_uint) -> c_int;
    fn rtlsdr_set_sample_rate(dev: *mut RtlSdrDev, rate: c_uint) -> c_int;
    fn rtlsdr_set_tuner_gain_mode(dev: *mut RtlSdrDev, manual: c_int) -> c_int;
    fn rtlsdr_set_tuner_gain(dev: *mut RtlSdrDev, tenths_db: c_int) -> c_int;
    fn rtlsdr_reset_buffer(dev: *mut RtlSdrDev) -> c_int;
    fn rtlsdr_read_sync(
        dev: *mut RtlSdrDev,
        buf: *mut c_void,
        len: c_int,
        n_read: *mut c_int,
    ) -> c_int;
}

/// librtlsdr requires the synchronous read length to be a multiple of 512, and
/// short reads below one USB transfer stall rather than returning early.
const READ_GRANULARITY: usize = 512;

/// Number of devices the driver can see. Safe to call with no device attached
/// and without opening anything, which makes it the one probe that does not
/// fight `dump1090` for the radio.
pub fn device_count() -> u32 {
    unsafe { rtlsdr_get_device_count() as u32 }
}

/// Driver-reported name for a device index, or None if the index is unused.
pub fn device_name(index: u32) -> Option<String> {
    let raw = unsafe { rtlsdr_get_device_name(index as c_uint) };
    if raw.is_null() {
        return None;
    }
    let name = unsafe { std::ffi::CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

pub struct RtlSdrSource {
    dev: *mut RtlSdrDev,
    center_hz: u64,
    sample_rate: u32,
}

// The handle is owned by exactly one RtlSdrSource and librtlsdr serialises no
// access of its own, so this type is Send (it may be moved to the sweep thread)
// and deliberately not Sync (two threads must not drive one radio).
unsafe impl Send for RtlSdrSource {}

impl RtlSdrSource {
    /// Turn a librtlsdr return code into an error that names the operation.
    /// Every entry point returns 0 on success and a negative libusb code
    /// otherwise, with no string form available.
    fn check(op: &str, rc: c_int) -> Result<(), SdrError> {
        if rc == 0 {
            Ok(())
        } else {
            Err(SdrError::ReadFailed(format!(
                "{op} failed (librtlsdr {rc})"
            )))
        }
    }
}

impl Drop for RtlSdrSource {
    fn drop(&mut self) {
        if !self.dev.is_null() {
            // Nothing useful to do with a failure here, and panicking in Drop
            // would mask whatever error is already unwinding. The kernel
            // reclaims the USB handle regardless.
            unsafe { rtlsdr_close(self.dev) };
            self.dev = std::ptr::null_mut();
        }
    }
}

impl SdrSource for RtlSdrSource {
    fn open(index: u32) -> Result<Self, SdrError> {
        if device_count() == 0 {
            return Err(SdrError::DeviceNotFound);
        }
        let mut dev: *mut RtlSdrDev = std::ptr::null_mut();
        let rc = unsafe { rtlsdr_open(&mut dev, index as c_uint) };
        if rc != 0 || dev.is_null() {
            // The overwhelmingly common cause is that something else already
            // holds the radio. On this project that something is dump1090,
            // which ADR-0008 gives the radio to, so say so rather than leaving
            // an operator reading a libusb number.
            return Err(SdrError::Config(format!(
                "opening SDR {index} failed (librtlsdr {rc}). If dump1090 is running it holds \
                 the radio -- ADR-0008 gives it the radio, and only one process can have it"
            )));
        }

        let mut source = RtlSdrSource {
            dev,
            center_hz: 0,
            sample_rate: RTLSDR_STABLE_SAMPLE_RATE,
        };
        // 3.2 MSPS is spec and drops samples in practice; start where the
        // hardware is actually reliable rather than where the datasheet is.
        source.set_sample_rate(RTLSDR_STABLE_SAMPLE_RATE)?;
        Ok(source)
    }

    fn min_hz(&self) -> u64 {
        RTLSDR_MIN_HZ
    }

    fn max_hz(&self) -> u64 {
        RTLSDR_MAX_HZ
    }

    fn set_center_freq(&mut self, hz: u64) -> Result<(), SdrError> {
        // Before the FFI call, so a DJI frequency produces the explanation in
        // SdrError::OutOfBand rather than a bare -1 from the tuner.
        self.check_tunable(hz)?;
        Self::check("rtlsdr_set_center_freq", unsafe {
            rtlsdr_set_center_freq(self.dev, hz as c_uint)
        })?;
        self.center_hz = hz;
        // Samples buffered before the retune belong to the previous frequency.
        // Keeping them would smear one band's energy into the next bin of a
        // sweep, which is indistinguishable from a real signal.
        Self::check("rtlsdr_reset_buffer", unsafe {
            rtlsdr_reset_buffer(self.dev)
        })
    }

    fn set_sample_rate(&mut self, sps: u32) -> Result<(), SdrError> {
        Self::check("rtlsdr_set_sample_rate", unsafe {
            rtlsdr_set_sample_rate(self.dev, sps as c_uint)
        })?;
        self.sample_rate = sps;
        Self::check("rtlsdr_reset_buffer", unsafe {
            rtlsdr_reset_buffer(self.dev)
        })
    }

    fn set_gain(&mut self, tenths_db: i32) -> Result<(), SdrError> {
        // Manual mode first: setting a gain while the tuner AGC owns it is
        // silently ignored, which looks like a gain control that does nothing.
        Self::check("rtlsdr_set_tuner_gain_mode", unsafe {
            rtlsdr_set_tuner_gain_mode(self.dev, 1)
        })?;
        Self::check("rtlsdr_set_tuner_gain", unsafe {
            rtlsdr_set_tuner_gain(self.dev, tenths_db as c_int)
        })
    }

    fn read_samples(&mut self, count: usize) -> Result<SampleBuffer, SdrError> {
        if count == 0 {
            return Ok(SampleBuffer {
                iq: Vec::new(),
                center_hz: self.center_hz,
                sample_rate: self.sample_rate,
            });
        }

        // One complex sample is an interleaved u8 pair, and the driver wants a
        // length that is a multiple of 512.
        let wanted = count * 2;
        let len = wanted.div_ceil(READ_GRANULARITY) * READ_GRANULARITY;
        let mut raw = vec![0u8; len];
        let mut n_read: c_int = 0;

        Self::check("rtlsdr_read_sync", unsafe {
            rtlsdr_read_sync(
                self.dev,
                raw.as_mut_ptr() as *mut c_void,
                len as c_int,
                &mut n_read,
            )
        })?;

        let got = n_read.max(0) as usize;
        if got == 0 {
            return Err(SdrError::ReadFailed(
                "the radio returned no samples; it may have been unplugged".into(),
            ));
        }
        raw.truncate(got.min(wanted));

        Ok(SampleBuffer {
            iq: to_complex(&raw),
            center_hz: self.center_hz,
            sample_rate: self.sample_rate,
        })
    }
}

/// Interleaved unsigned bytes to centred complex samples.
///
/// The RTL2832U emits offset binary: 0..=255 around a 127.5 midpoint, not a
/// signed value. Subtracting 128 instead -- the obvious integer choice --
/// leaves a half-LSB DC offset that a sweep reads as a permanent carrier at the
/// centre frequency, which is a false detection in exactly the band this
/// sensor exists to watch.
fn to_complex(raw: &[u8]) -> Vec<Complex<f32>> {
    const MID: f32 = 127.5;
    raw.chunks_exact(2)
        .map(|p| Complex::new((p[0] as f32 - MID) / MID, (p[1] as f32 - MID) / MID))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hardware-free: the conversion is pure arithmetic on a byte slice.
    #[test]
    fn centres_offset_binary_on_zero() {
        // 128 is the first code above the 127.5 midpoint, so it must be a small
        // positive value rather than exactly zero.
        let out = to_complex(&[128, 128]);
        assert!(out[0].re > 0.0 && out[0].re < 0.01, "{:?}", out[0]);

        // A balanced pair either side of the midpoint must cancel.
        let pair = to_complex(&[127, 128]);
        assert!((pair[0].re + pair[0].im).abs() < 1e-6, "{:?}", pair[0]);
    }

    #[test]
    fn maps_the_full_scale_to_plus_minus_one() {
        let out = to_complex(&[255, 0]);
        assert!((out[0].re - 1.0).abs() < 0.01, "{:?}", out[0]);
        assert!((out[0].im + 1.0).abs() < 0.01, "{:?}", out[0]);
    }

    /// An odd trailing byte is half a sample and must be dropped, not read past.
    #[test]
    fn ignores_a_trailing_half_sample() {
        assert_eq!(to_complex(&[10, 20, 30]).len(), 1);
    }

    /// Probing the driver must not require a radio: this is what the `probe`
    /// subcommand relies on to report "none found" instead of failing to open.
    #[test]
    fn counting_devices_needs_no_hardware() {
        let _ = device_count();
    }
}

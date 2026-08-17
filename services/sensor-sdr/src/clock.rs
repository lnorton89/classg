//! Wall-clock reading and RFC3339 formatting, on std alone.
//!
//! `chrono` and `time` would each do this in one line, but this crate needs
//! exactly two operations -- "what is the epoch millisecond" and "print it the
//! way the schema wants" -- and the CI `rust` job installs no system packages
//! and audits every dependency. A calendar is ~40 lines of arithmetic that
//! cannot rot; see the module note in `zmtp.rs` for the same reasoning applied
//! to a much larger dependency.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch. Negative before 1970, which only shows up
/// if the Pi boots with no RTC and no NTP yet -- a real state on this hardware,
/// so the formatter below handles it rather than panicking.
pub fn epoch_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(err) => -(err.duration().as_millis() as i64),
    }
}

pub fn now_rfc3339() -> String {
    rfc3339_ms(epoch_ms())
}

/// RFC3339 UTC with millisecond precision, the shape `detection.schema.json`
/// specifies for `ts`.
pub fn rfc3339_ms(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);

    let (year, month, day) = civil_from_days(days);
    let (h, m, s, milli) = (
        ms_of_day / 3_600_000,
        (ms_of_day / 60_000) % 60,
        (ms_of_day / 1_000) % 60,
        ms_of_day % 1_000,
    );
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

/// Howard Hinnant's `civil_from_days`, which is the standard closed form and is
/// correct for the whole proleptic Gregorian range rather than only for dates
/// after 1970.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March-based
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_epoch_itself() {
        assert_eq!(rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
    }

    /// The exact timestamp the SBS fixtures and `sample_detection()` use, so a
    /// drift here shows up as a mismatch with the rest of the crate.
    #[test]
    fn formats_a_known_instant() {
        assert_eq!(rfc3339_ms(1_786_458_191_482), "2026-08-11T14:23:11.482Z");
    }

    #[test]
    fn handles_leap_days() {
        // 2024-02-29T12:00:00Z
        assert_eq!(rfc3339_ms(1_709_208_000_000), "2024-02-29T12:00:00.000Z");
        // 2000 is a leap year, 1900 was not -- the two cases a naive rule gets
        // wrong.
        assert_eq!(rfc3339_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    /// A Pi with no RTC comes up before 1970 until NTP lands. Formatting must
    /// produce a wrong-but-well-formed timestamp rather than panic on the
    /// negative remainder.
    #[test]
    fn survives_a_clock_that_has_not_been_set() {
        assert_eq!(rfc3339_ms(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(rfc3339_ms(-86_400_000), "1969-12-31T00:00:00.000Z");
    }

    #[test]
    fn now_is_shaped_like_the_schema_wants() {
        let ts = now_rfc3339();
        assert_eq!(ts.len(), 24, "{ts}");
        assert!(ts.ends_with('Z'), "{ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
        assert_eq!(&ts[19..20], ".");
    }
}

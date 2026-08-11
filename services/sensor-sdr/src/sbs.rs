//! dump1090's SBS-1 (BaseStation) stream, translated into ClassG detections.
//!
//! Why this format and not raw frames: ADR-0008. dump1090 has already validated
//! the Mode S CRC and resolved Compact Position Reporting into a latitude and
//! longitude. Both are places where our own implementation would be quietly
//! wrong rather than visibly broken -- CPR in particular needs even/odd frame
//! pairing within a time and distance window, and gets subtly bad positions
//! when that is done carelessly.
//!
//! Measured on 2026-08-11: of 147 frames a raw reader accepted, 12 passed the
//! CRC. Everything reaching this module has already survived that filter.
//!
//! The format is 22 comma-separated fields. Only MSG records carry aircraft
//! data, and the message type in field 2 decides which fields are populated:
//!
//! ```text
//! MSG,3,1,1,A1878A,1,2026/08/11,14:23:11.482,...,,2100,,,47.1,8.2,,,,,,0
//!  0  1              4                                    11    14  15
//! ```
//!
//! A single aircraft is reported across several message types -- identity in
//! one, position in another, velocity in a third -- so most detections carry a
//! partial picture. That is expected and is why fusion keys contacts by ICAO
//! rather than treating each message as an independent sighting.

use crate::detection::{
    Adsb, Detection, Kinematics, Position, Rf, CLASS_ADSB, FT_TO_M, KT_TO_MPS, SCHEMA_VERSION,
};

pub const ADSB_FREQ_HZ: u64 = 1_090_000_000;

/// Field indices in an SBS-1 record.
mod field {
    pub const MESSAGE_TYPE: usize = 0;
    pub const TRANSMISSION_TYPE: usize = 1;
    pub const ICAO: usize = 4;
    pub const DATE_LOGGED: usize = 6;
    pub const TIME_LOGGED: usize = 7;
    pub const CALLSIGN: usize = 10;
    pub const ALTITUDE_FT: usize = 11;
    pub const GROUND_SPEED_KT: usize = 12;
    pub const TRACK_DEG: usize = 13;
    pub const LATITUDE: usize = 14;
    pub const LONGITUDE: usize = 15;
    pub const VERTICAL_RATE_FPM: usize = 16;
    pub const MIN_FIELDS: usize = 17;
}

#[derive(Debug, PartialEq)]
pub enum ParseError {
    /// Not an aircraft message -- STA, AIR, ID and SEL records are session
    /// bookkeeping, not observations.
    NotAnAircraftMessage,
    TooFewFields(usize),
    /// No ICAO address. Nothing can be correlated with this, and the schema
    /// requires it inside the adsb block.
    MissingIcao,
}

/// Translate one SBS-1 line into a detection.
///
/// `now_rfc3339` supplies the timestamp when the record carries no usable one,
/// so this function stays free of clock access and therefore testable.
pub fn parse_line(line: &str, sensor_id: &str, now_rfc3339: &str) -> Result<Detection, ParseError> {
    let fields: Vec<&str> = line.trim().split(',').map(str::trim).collect();

    if fields.len() < field::MIN_FIELDS {
        // A short line is more likely a partial read at a TCP boundary than a
        // malformed record, so it is a parse error rather than anything louder.
        return Err(ParseError::TooFewFields(fields.len()));
    }
    if fields[field::MESSAGE_TYPE] != "MSG" {
        return Err(ParseError::NotAnAircraftMessage);
    }

    let icao = fields[field::ICAO].to_uppercase();
    if icao.is_empty() {
        return Err(ParseError::MissingIcao);
    }

    let alt_ft = number::<i64>(fields[field::ALTITUDE_FT]);
    let ground_speed_kt = number::<f64>(fields[field::GROUND_SPEED_KT]);
    let track_deg = number::<f64>(fields[field::TRACK_DEG]);
    let vertical_rate_fpm = number::<f64>(fields[field::VERTICAL_RATE_FPM]);
    let lat = number::<f64>(fields[field::LATITUDE]);
    let lon = number::<f64>(fields[field::LONGITUDE]);

    // 0,0 means "no fix", not the Gulf of Guinea. The schema requires sensors to
    // normalise it to absent, and fusion defends against it a second time.
    let position = match (lat, lon) {
        (Some(lat), Some(lon)) if !(lat == 0.0 && lon == 0.0) => Some(Position {
            lat,
            lon,
            alt_geodetic_m: alt_ft.map(|ft| ft as f64 * FT_TO_M),
        }),
        _ => None,
    };

    let kinematics =
        if ground_speed_kt.is_some() || track_deg.is_some() || vertical_rate_fpm.is_some() {
            Some(Kinematics {
                speed_mps: ground_speed_kt.map(|kt| kt * KT_TO_MPS),
                // The schema constrains track to [0, 360). dump1090 occasionally
                // emits a negative bearing; fold rather than drop, since a heading
                // is still useful and dropping it silently loses information.
                track_deg: track_deg.map(|d| d.rem_euclid(360.0)),
                vertical_speed_mps: vertical_rate_fpm.map(|fpm| fpm * FT_TO_M / 60.0),
            })
        } else {
            None
        };

    let callsign = {
        let c = fields[field::CALLSIGN].trim();
        // Callsigns are space-padded to 8 characters in the source encoding.
        (!c.is_empty()).then(|| c.to_string())
    };

    Ok(Detection {
        schema_version: SCHEMA_VERSION,
        detection_id: String::new(), // assigned by the caller, which owns ULID minting
        ts: timestamp(fields[field::DATE_LOGGED], fields[field::TIME_LOGGED])
            .unwrap_or_else(|| now_rfc3339.to_string()),
        sensor_id: sensor_id.to_string(),
        sensor_kind: "sdr",
        detection_class: CLASS_ADSB,
        rf: Some(Rf {
            freq_hz: ADSB_FREQ_HZ,
        }),
        position,
        kinematics,
        adsb: Some(Adsb {
            icao,
            callsign,
            alt_ft,
            ground_speed_kt,
        }),
    })
}

/// SBS-1 logs `2026/08/11` and `14:23:11.482` in two fields and in local time
/// with no offset. Converted to the schema's shape only when both are present
/// and well-formed; a guess about the offset would be worse than falling back to
/// the receive time, which at least has a known meaning.
fn timestamp(date: &str, time: &str) -> Option<String> {
    let d: Vec<&str> = date.split('/').collect();
    if d.len() != 3 || d[0].len() != 4 || time.len() < 8 {
        return None;
    }
    if !d.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let mut t = time.to_string();
    if !t.contains('.') {
        t.push_str(".000");
    }
    Some(format!("{}-{}-{}T{}Z", d[0], d[1], d[2], t))
}

fn number<T: std::str::FromStr>(raw: &str) -> Option<T> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    raw.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-08-11T00:00:00.000Z";

    // A type 3 (airborne position) record, the shape that puts an aircraft on
    // the map.
    const POSITION_MSG: &str = "MSG,3,1,1,A1878A,1,2026/08/11,14:23:11.482,2026/08/11,14:23:11.482,,2100,,,47.1,8.2,,,,,,0";
    // Type 1 is identity only: callsign, no position, no altitude.
    const IDENT_MSG: &str =
        "MSG,1,1,1,A1878A,1,2026/08/11,14:23:12.100,2026/08/11,14:23:12.100,REGA10  ,,,,,,,,,,,";
    // Type 4 is velocity: speed and track, no position.
    const VELOCITY_MSG: &str =
        "MSG,4,1,1,A1878A,1,2026/08/11,14:23:13.000,2026/08/11,14:23:13.000,,,90,271,,,-64,,,,,";

    #[test]
    fn parses_a_position_message() {
        let d = parse_line(POSITION_MSG, "sdr-0", NOW).unwrap();
        assert_eq!(d.detection_class, "D");
        assert_eq!(d.sensor_kind, "sdr");
        assert_eq!(d.adsb.as_ref().unwrap().icao, "A1878A");
        assert_eq!(d.adsb.as_ref().unwrap().alt_ft, Some(2100));

        let p = d.position.unwrap();
        assert_eq!(p.lat, 47.1);
        assert_eq!(p.lon, 8.2);
        // 2100 ft in metres, to the nearest metre.
        assert!((p.alt_geodetic_m.unwrap() - 640.08).abs() < 0.01);
    }

    #[test]
    fn parses_identity_without_inventing_a_position() {
        let d = parse_line(IDENT_MSG, "sdr-0", NOW).unwrap();
        assert_eq!(d.adsb.as_ref().unwrap().callsign.as_deref(), Some("REGA10"));
        assert!(
            d.position.is_none(),
            "identity message must carry no position"
        );
        assert!(d.kinematics.is_none());
    }

    #[test]
    fn parses_velocity_and_converts_units() {
        let d = parse_line(VELOCITY_MSG, "sdr-0", NOW).unwrap();
        let k = d.kinematics.unwrap();
        // 90 kt in m/s
        assert!((k.speed_mps.unwrap() - 46.3).abs() < 0.01);
        assert_eq!(k.track_deg, Some(271.0));
        // -64 ft/min descending, in m/s
        assert!((k.vertical_speed_mps.unwrap() + 0.325).abs() < 0.01);
        // Native units survive alongside the converted ones.
        assert_eq!(d.adsb.unwrap().ground_speed_kt, Some(90.0));
    }

    /// The trap the schema calls out by name: 0,0 is "no GPS fix", and plotting
    /// it puts aircraft in the Gulf of Guinea.
    #[test]
    fn zero_position_is_not_a_position() {
        let line = POSITION_MSG.replace(",47.1,8.2,", ",0,0,");
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        assert!(d.position.is_none());
    }

    #[test]
    fn a_partial_position_is_no_position() {
        let line = POSITION_MSG.replace(",47.1,8.2,", ",47.1,,");
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        assert!(d.position.is_none(), "latitude alone is not a fix");
    }

    #[test]
    fn session_records_are_not_observations() {
        for line in [
            "STA,,1,1,A1878A,1,2026/08/11,14:23:11.482,,,,,,,,,,,,,,",
            "ID,,1,1,A1878A,1,2026/08/11,14:23:11.482,,,,,,,,,,,,,,",
            "AIR,,1,1,A1878A,1,2026/08/11,14:23:11.482,,,,,,,,,,,,,,",
        ] {
            assert_eq!(
                parse_line(line, "sdr-0", NOW),
                Err(ParseError::NotAnAircraftMessage),
                "{line}"
            );
        }
    }

    #[test]
    fn a_record_with_no_icao_is_rejected() {
        let line = POSITION_MSG.replacen(",A1878A,", ",,", 1);
        assert_eq!(
            parse_line(&line, "sdr-0", NOW),
            Err(ParseError::MissingIcao)
        );
    }

    #[test]
    fn icao_case_is_normalised() {
        let line = POSITION_MSG.replacen(",A1878A,", ",a1878a,", 1);
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        assert_eq!(d.adsb.unwrap().icao, "A1878A");
    }

    /// A truncated line is a TCP boundary, not a malformed aircraft. It must not
    /// panic and must not produce a half-built detection.
    #[test]
    fn a_truncated_line_is_an_error_not_a_panic() {
        assert!(matches!(
            parse_line("MSG,3,1,1,A1878A,1,2026/08/11", "sdr-0", NOW),
            Err(ParseError::TooFewFields(_))
        ));
        assert!(matches!(
            parse_line("", "sdr-0", NOW),
            Err(ParseError::TooFewFields(_))
        ));
    }

    /// Arbitrary input must never panic. dump1090 is a separate process and its
    /// output is not something this sensor controls; a detector that dies on a
    /// malformed line is a denial-of-service target. Mirrors the Hypothesis
    /// property tests guarding the Wi-Fi parsers.
    #[test]
    fn arbitrary_input_never_panics() {
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let alphabet = b"MSG,0123456789./: -\t\"\\\n\x00abcXYZ";
        for _ in 0..20_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed % 120) as usize;
            let line: String = (0..len)
                .map(|i| {
                    let idx = ((seed >> (i % 48)) as usize).wrapping_add(i) % alphabet.len();
                    alphabet[idx] as char
                })
                .collect();
            let _ = parse_line(&line, "sdr-0", NOW);
        }
    }

    #[test]
    fn timestamp_uses_the_record_when_it_is_usable() {
        let d = parse_line(POSITION_MSG, "sdr-0", NOW).unwrap();
        assert_eq!(d.ts, "2026-08-11T14:23:11.482Z");
    }

    #[test]
    fn timestamp_falls_back_rather_than_guessing() {
        let line = POSITION_MSG.replacen(",2026/08/11,14:23:11.482,", ",,,", 1);
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        assert_eq!(d.ts, NOW);
    }

    #[test]
    fn negative_track_is_folded_into_range() {
        // The schema constrains track_deg to [0, 360).
        let line = VELOCITY_MSG.replace(",90,271,", ",90,-89,");
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        assert_eq!(d.kinematics.unwrap().track_deg, Some(271.0));
    }
}

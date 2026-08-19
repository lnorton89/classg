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
    /// Not read: the parser derives what is populated from the fields
    /// themselves rather than from the declared transmission type, so a
    /// dump1090 that mislabels a record still yields whatever it did carry.
    /// Kept because the module's field map is only legible if it is complete.
    #[allow(dead_code)]
    pub const TRANSMISSION_TYPE: usize = 1;
    pub const ICAO: usize = 4;
    // 6 and 7 are the logged date and time. Deliberately absent: dump1090
    // writes them with localtime(), and there is no offset in the record to
    // recover UTC from. See the ts assignment in parse_line.
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
/// `now_rfc3339` is the timestamp, always -- the record's own is local time
/// with no offset. Passing it in keeps this function free of clock access and
/// therefore testable.
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
    //
    // The range check is the other half of the same defence: dump1090 is a
    // separate process and a corrupt line (lat=91, or "nan", which f64 parses)
    // would otherwise become a schema-invalid position that fusion's plain
    // json.Unmarshal accepts without a murmur. Rejected rather than clamped --
    // a clamped position is a confident lie about where the aircraft is.
    // NaN fails both range comparisons, so it is rejected here too.
    let position = match (lat, lon) {
        (Some(lat), Some(lon))
            if !(lat == 0.0 && lon == 0.0)
                && (-90.0..=90.0).contains(&lat)
                && (-180.0..=180.0).contains(&lon) =>
        {
            Some(Position {
                lat,
                lon,
                alt_geodetic_m: alt_ft.map(|ft| ft as f64 * FT_TO_M),
            })
        }
        _ => None,
    };

    let kinematics =
        if ground_speed_kt.is_some() || track_deg.is_some() || vertical_rate_fpm.is_some() {
            Some(Kinematics {
                // speed_mps has a schema minimum of 0; a negative ground speed
                // is a corrupt record, not a direction.
                speed_mps: ground_speed_kt
                    .filter(|kt| *kt >= 0.0)
                    .map(|kt| kt * KT_TO_MPS),
                // The schema constrains track to [0, 360). dump1090 occasionally
                // emits a negative bearing; fold rather than drop, since a heading
                // is still useful and dropping it silently loses information.
                // rem_euclid alone is not enough: for a tiny negative input the
                // result rounds up to exactly 360.0, which exclusiveMaximum
                // rejects, so that one value folds on to 0.0.
                track_deg: track_deg.map(|d| {
                    let t = d.rem_euclid(360.0);
                    if t >= 360.0 {
                        0.0
                    } else {
                        t
                    }
                }),
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
        // The record's own date and time fields are deliberately NOT used.
        //
        // dump1090 formats them with localtime(), so on a Pi in PDT a message
        // received at 02:38Z is written "2026/08/16,19:38:26". Appending Z to
        // that -- which this did -- produces a timestamp seven hours in the
        // past, asserted as UTC.
        //
        // Observed on the Pi: detections landed with ts 2026-08-16T19:38:26Z
        // while the process logged the same event at 2026-08-17T02:38:26Z. The
        // API's five-minute windows dropped them, and since detection
        // timestamps are what fusion correlates on, Class D could never have
        // lined up with a Wi-Fi detection to suppress it -- which is the whole
        // reason ADS-B is here.
        //
        // Receive time is what we can state correctly. The only thing the
        // record time offered over it was dump1090's own buffering delay,
        // which is not worth a timezone bug.
        ts: now_rfc3339.to_string(),
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
    fn record_local_time_is_never_passed_off_as_utc() {
        // POSITION_MSG carries 2026/08/11,14:23:11.482. dump1090 writes those
        // fields with localtime(), so stamping them Z put detections seven
        // hours in the past on a PDT Pi -- outside every window the API and
        // fusion correlate over.
        let d = parse_line(POSITION_MSG, "sdr-0", NOW).unwrap();
        assert_eq!(d.ts, NOW);
        assert!(
            !d.ts.starts_with("2026-08-11T14:23:11"),
            "the record's local time was used as though it were UTC"
        );
    }

    #[test]
    fn timestamp_is_the_receive_time_even_when_the_record_has_none() {
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

    /// rem_euclid of a tiny negative bearing rounds up to exactly 360.0 in
    /// f64, which the schema's exclusiveMaximum rejects. It must fold to 0.
    #[test]
    fn a_tiny_negative_track_folds_to_zero_not_360() {
        let line = VELOCITY_MSG.replace(",90,271,", ",90,-0.000000000000001,");
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        let track = d.kinematics.unwrap().track_deg.unwrap();
        assert_eq!(track, 0.0, "got {track}");
    }

    /// A corrupt line must not become a schema-invalid position. dump1090's
    /// output is not something this sensor controls.
    #[test]
    fn out_of_range_coordinates_are_rejected_not_forwarded() {
        for (lat, lon) in [
            ("91", "8.2"),
            ("-91", "8.2"),
            ("47.1", "181"),
            ("47.1", "-181"),
        ] {
            let line = POSITION_MSG.replace(",47.1,8.2,", &format!(",{lat},{lon},"));
            let d = parse_line(&line, "sdr-0", NOW).unwrap();
            assert!(d.position.is_none(), "lat={lat} lon={lon} was accepted");
        }
    }

    /// "nan" parses as a perfectly good f64, and NaN survives every equality
    /// check. The range comparison is what keeps it off the wire.
    #[test]
    fn nan_coordinates_are_rejected() {
        let line = POSITION_MSG.replace(",47.1,8.2,", ",nan,nan,");
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        assert!(d.position.is_none());
    }

    /// speed_mps has a schema minimum of 0; a negative ground speed is
    /// corruption, not information.
    #[test]
    fn a_negative_ground_speed_is_dropped() {
        let line = VELOCITY_MSG.replace(",90,271,", ",-90,271,");
        let d = parse_line(&line, "sdr-0", NOW).unwrap();
        assert_eq!(d.kinematics.unwrap().speed_mps, None);
    }
}

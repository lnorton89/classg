//! The wire format, mirroring `schemas/detection.schema.json`.
//!
//! Four services in four languages read that schema, so this file is not free to
//! drift from it. `additionalProperties: false` means an invented field is a hard
//! validation failure, not a tolerated extra -- see the conformance tests at the
//! bottom of this file and the CI `schemas` job.

use serde::Serialize;

pub const SCHEMA_VERSION: &str = "1.0";

/// Detection classes this sensor can produce. Class D is Milestone 2; E and F
/// arrive with the sweep engine in Milestone 3.
pub const CLASS_ADSB: &str = "D";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Detection {
    pub schema_version: &'static str,
    pub detection_id: String,
    /// RFC3339 UTC, millisecond precision.
    pub ts: String,
    pub sensor_id: String,
    pub sensor_kind: &'static str,
    pub detection_class: &'static str,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub rf: Option<Rf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinematics: Option<Kinematics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adsb: Option<Adsb>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Rf {
    pub freq_hz: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Position {
    pub lat: f64,
    pub lon: f64,
    /// Geodetic altitude in metres. ADS-B reports feet, so this is a conversion;
    /// the unconverted value stays in `adsb.alt_ft`, which is what the UI shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_geodetic_m: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Kinematics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_mps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical_speed_mps: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Adsb {
    pub icao: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callsign: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_ft: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ground_speed_kt: Option<f64>,
}

/// Feet to metres. ADS-B altitude is feet natively and stays that way in
/// `adsb.alt_ft`; this exists only because `position.alt_geodetic_m` is metres
/// by schema, and a track's altitude has to be comparable with a drone's.
pub const FT_TO_M: f64 = 0.3048;
/// Knots to metres per second, for the same reason.
pub const KT_TO_MPS: f64 = 0.514_444;

/// One fully-populated Class D detection, in the shape this sensor emits.
///
/// Not test-only: `--emit-sample-detection` prints it so the CI `schemas` job can
/// validate this sensor's output against `schemas/detection.schema.json` the way
/// it already does for sensor-wifi. A cross-language contract that only three of
/// the four languages are checked against is a contract with a hole in it.
pub fn sample_detection() -> Detection {
    Detection {
        schema_version: SCHEMA_VERSION,
        detection_id: "01J8XQ0000000000000000000A".into(),
        ts: "2026-08-11T14:23:11.482Z".into(),
        sensor_id: "sdr-0".into(),
        sensor_kind: "sdr",
        detection_class: CLASS_ADSB,
        rf: Some(Rf {
            freq_hz: crate::sbs::ADSB_FREQ_HZ,
        }),
        position: Some(Position {
            lat: 47.1,
            lon: 8.2,
            alt_geodetic_m: Some(640.08),
        }),
        kinematics: Some(Kinematics {
            speed_mps: Some(46.3),
            track_deg: Some(271.0),
            vertical_speed_mps: Some(-0.325),
        }),
        adsb: Some(Adsb {
            icao: "A1878A".into(),
            callsign: Some("REGA10".into()),
            alt_ft: Some(2100),
            ground_speed_kt: Some(90.0),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn sample() -> Detection {
        Detection {
            schema_version: SCHEMA_VERSION,
            detection_id: "01J8XQ0000000000000000000A".into(),
            ts: "2026-08-11T14:23:11.482Z".into(),
            sensor_id: "sdr-0".into(),
            sensor_kind: "sdr",
            detection_class: CLASS_ADSB,
            rf: Some(Rf {
                freq_hz: 1_090_000_000,
            }),
            position: Some(Position {
                lat: 47.1,
                lon: 8.2,
                alt_geodetic_m: Some(640.0),
            }),
            kinematics: Some(Kinematics {
                speed_mps: Some(46.3),
                track_deg: Some(271.0),
                vertical_speed_mps: None,
            }),
            adsb: Some(Adsb {
                icao: "A1878A".into(),
                callsign: Some("REGA10".into()),
                alt_ft: Some(2100),
                ground_speed_kt: Some(90.0),
            }),
        }
    }

    /// The schema sets `additionalProperties: false` at every level, so a field
    /// this sensor invents is rejected outright by the other three services
    /// rather than ignored. Keeping the key list here means a rename shows up as
    /// a failing test in this crate rather than as a silent wire mismatch.
    #[test]
    fn emits_only_fields_the_schema_declares() {
        let allowed_top = [
            "schema_version",
            "detection_id",
            "ts",
            "sensor_id",
            "sensor_kind",
            "detection_class",
            "rf",
            "identity",
            "position",
            "kinematics",
            "operator",
            "signal_features",
            "adsb",
            "raw",
        ];
        let allowed_adsb = ["icao", "callsign", "alt_ft", "ground_speed_kt"];
        let allowed_position = [
            "lat",
            "lon",
            "alt_geodetic_m",
            "alt_pressure_m",
            "height_agl_m",
            "h_accuracy_m",
            "v_accuracy_m",
        ];
        let allowed_kinematics = ["speed_mps", "track_deg", "vertical_speed_mps"];
        let allowed_rf = ["freq_hz", "channel", "rssi_dbm", "bandwidth_hz", "snr_db"];

        let v: Value = serde_json::from_str(&serde_json::to_string(&sample()).unwrap()).unwrap();

        let check = |obj: &Value, allowed: &[&str], what: &str| {
            for key in obj.as_object().unwrap().keys() {
                assert!(
                    allowed.contains(&key.as_str()),
                    "{what}: {key:?} is not in the schema"
                );
            }
        };
        check(&v, &allowed_top, "detection");
        check(&v["adsb"], &allowed_adsb, "adsb");
        check(&v["position"], &allowed_position, "position");
        check(&v["kinematics"], &allowed_kinematics, "kinematics");
        check(&v["rf"], &allowed_rf, "rf");
    }

    #[test]
    fn required_fields_are_always_present() {
        let v: Value = serde_json::from_str(&serde_json::to_string(&sample()).unwrap()).unwrap();
        for key in [
            "schema_version",
            "detection_id",
            "ts",
            "sensor_id",
            "sensor_kind",
            "detection_class",
        ] {
            assert!(!v[key].is_null(), "required field {key} missing");
        }
        assert_eq!(v["schema_version"], "1.0");
    }

    /// A Class D detection with no ICAO cannot be correlated with anything and
    /// the schema marks `icao` required within the adsb block.
    #[test]
    fn adsb_block_always_carries_an_icao() {
        let v: Value = serde_json::from_str(&serde_json::to_string(&sample()).unwrap()).unwrap();
        assert!(v["adsb"]["icao"].as_str().is_some_and(|s| !s.is_empty()));
    }

    /// Absent fields are omitted rather than serialised as null. The schema
    /// permits null for most of them, but an omitted key and an explicit null
    /// read differently downstream, and "we did not observe this" is the honest
    /// one for a message type that simply did not carry the field.
    #[test]
    fn unobserved_fields_are_omitted_not_nulled() {
        let mut d = sample();
        d.position = None;
        d.kinematics = None;
        let s = serde_json::to_string(&d).unwrap();
        assert!(!s.contains("position"), "{s}");
        assert!(!s.contains("kinematics"), "{s}");
    }
}

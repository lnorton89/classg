//! Configuration, on ADR-0007's terms.
//!
//! Everything here is Tier 2 -- bus endpoints, topics, capture parameters -- so
//! the environment is an override rather than the only source. This sensor has
//! no database connection of its own, so its effective tiers are `environment >
//! .env file > built-in default`.
//!
//! The part of ADR-0007 that actually matters is not the precedence, it is that
//! **the source of every effective value is reported at runtime**. `Settings`
//! carries a `source` alongside each value and the runtime prints it at
//! startup, so "why is it pointed at that endpoint" never needs archaeology.
//!
//! Variable naming follows the fleet: bus-wide keys are shared with fusion and
//! the Wi-Fi sensor (`CLASSG_DETECTION_ENDPOINT`, `CLASSG_DETECTION_TOPIC`,
//! `CLASSG_HEARTBEAT_TOPIC`); sensor-local ones take the `CLASSG_SDR_` prefix
//! the way the Wi-Fi sensor takes `CLASSG_WIFI_`.

use std::env;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use crate::zmtp::SocketMode;

pub const DEFAULT_ENDPOINT: &str = "tcp://127.0.0.1:5556";
pub const DEFAULT_DUMP1090: &str = "127.0.0.1:30003";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Env,
    EnvFile,
    Default,
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Source::Env => "env",
            Source::EnvFile => "env-file",
            Source::Default => "default",
        })
    }
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub sensor_id: String,
    pub dump1090: String,
    pub endpoint: String,
    pub detection_topic: String,
    pub heartbeat_topic: String,
    pub socket_mode: SocketMode,
    pub hwm: usize,
    pub heartbeat_interval: Duration,
    pub reconnect_max: Duration,
    sources: Vec<(&'static str, String, Source)>,
}

impl Settings {
    /// Read the process environment.
    pub fn from_env(from_file: &[String]) -> Result<Self, Vec<String>> {
        Self::resolve(&|key| env::var(key).ok(), from_file)
    }

    /// Resolve settings from an arbitrary lookup.
    ///
    /// Taking the lookup as a parameter is not indirection for its own sake: it
    /// is what lets the tests cover every branch without calling
    /// `env::set_var`, which mutates process-global state that the other tests
    /// in this crate are reading from other threads at the same time. Rust 2024
    /// marks that function `unsafe` for exactly this reason.
    ///
    /// Returns every problem it finds rather than the first, because a
    /// misconfigured unit should be fixable in one pass.
    fn resolve(
        get: &dyn Fn(&str) -> Option<String>,
        from_file: &[String],
    ) -> Result<Self, Vec<String>> {
        let mut errors = Vec::new();
        let mut sources = Vec::new();
        let mut value = |key: &'static str, fallback: &str| -> String {
            let set = get(key).filter(|v| !v.trim().is_empty());
            let source = match &set {
                Some(_) if from_file.iter().any(|k| k == key) => Source::EnvFile,
                Some(_) => Source::Env,
                None => Source::Default,
            };
            let value = set
                .map(|v| v.trim().to_string())
                .unwrap_or_else(|| fallback.to_string());
            sources.push((key, value.clone(), source));
            value
        };

        let sensor_id = value("CLASSG_SDR_SENSOR_ID", "sdr-0");
        let dump1090 = value("CLASSG_SDR_DUMP1090_ADDR", DEFAULT_DUMP1090);
        let endpoint = value("CLASSG_DETECTION_ENDPOINT", DEFAULT_ENDPOINT);
        let detection_topic = value("CLASSG_DETECTION_TOPIC", "detection.");
        let heartbeat_topic = value("CLASSG_HEARTBEAT_TOPIC", "heartbeat.");

        // `connect`, not `bind`, and deliberately different from the Wi-Fi
        // sensor's default: two PUB sockets cannot bind the same endpoint, and
        // the Wi-Fi sensor already owns the bind side in the all-native layout.
        // A second sensor therefore has to dial out, which means fusion must be
        // the listener (CLASSG_FUSION_DETECTION_SOCKET_MODE=listen) whenever
        // both sensors run -- the same direction the Compose layout already
        // uses. Getting this wrong is visible rather than silent: the handshake
        // is refused with the peer's socket type in the message.
        let socket_mode_raw = value("CLASSG_SDR_SOCKET_MODE", "connect");
        let socket_mode = match SocketMode::parse(&socket_mode_raw) {
            Ok(m) => m,
            Err(err) => {
                errors.push(format!("CLASSG_SDR_SOCKET_MODE: {err}"));
                SocketMode::Connect
            }
        };

        let hwm_raw = value("CLASSG_SDR_ZMQ_HWM", "1000");
        let hwm = match hwm_raw.parse::<usize>() {
            Ok(v) if v > 0 => v,
            _ => {
                errors.push(format!(
                    "CLASSG_SDR_ZMQ_HWM: {hwm_raw:?} is not a positive integer"
                ));
                1000
            }
        };

        let heartbeat_raw = value("CLASSG_SDR_HEARTBEAT_S", "10");
        let heartbeat_interval = match heartbeat_raw.parse::<f64>() {
            Ok(v) if v > 0.0 => Duration::from_secs_f64(v),
            _ => {
                errors.push(format!(
                    "CLASSG_SDR_HEARTBEAT_S: {heartbeat_raw:?} is not a positive number of seconds"
                ));
                Duration::from_secs(10)
            }
        };

        let reconnect_raw = value("CLASSG_SDR_RECONNECT_MAX_S", "30");
        let reconnect_max = match reconnect_raw.parse::<f64>() {
            Ok(v) if v > 0.0 => Duration::from_secs_f64(v),
            _ => {
                errors.push(format!(
                    "CLASSG_SDR_RECONNECT_MAX_S: {reconnect_raw:?} is not a positive number of seconds"
                ));
                Duration::from_secs(30)
            }
        };

        if sensor_id.trim().is_empty() {
            errors.push("CLASSG_SDR_SENSOR_ID: must not be empty".into());
        }

        if errors.is_empty() {
            Ok(Self {
                sensor_id,
                dump1090,
                endpoint,
                detection_topic,
                heartbeat_topic,
                socket_mode,
                hwm,
                heartbeat_interval,
                reconnect_max,
                sources,
            })
        } else {
            Err(errors)
        }
    }

    /// `(key, effective value, where it came from)` for every setting.
    pub fn report(&self) -> &[(&'static str, String, Source)] {
        &self.sources
    }
}

/// Load the nearest `.env`, the way the API, fusion and the Wi-Fi CLI do.
///
/// Returns the keys it actually set, so [`Settings::from_env`] can report them
/// as `env-file` rather than `env`. Values already present in the process
/// environment win, which is what makes systemd's `EnvironmentFile` and an
/// explicit `Environment=` behave the way `docs/ops/00-configuration.md`
/// promises.
pub fn load_env_file() -> Vec<String> {
    let path = match env::var("CLASSG_ENV_FILE") {
        Ok(explicit) if !explicit.trim().is_empty() => {
            let p = PathBuf::from(explicit.trim());
            if !p.exists() {
                eprintln!(
                    "{} config: CLASSG_ENV_FILE does not exist: {}",
                    crate::clock::now_rfc3339(),
                    p.display()
                );
                return Vec::new();
            }
            p
        }
        _ => match find_dotenv() {
            Some(p) => p,
            None => return Vec::new(),
        },
    };

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(err) => {
            eprintln!(
                "{} config: could not read {}: {err}",
                crate::clock::now_rfc3339(),
                path.display()
            );
            return Vec::new();
        }
    };

    let mut applied = Vec::new();
    for (key, value) in parse_dotenv(&text) {
        if env::var_os(&key).is_none() {
            env::set_var(&key, &value);
            applied.push(key);
        }
    }
    applied
}

fn find_dotenv() -> Option<PathBuf> {
    let mut dir: PathBuf = env::current_dir().ok()?;
    loop {
        let candidate = dir.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// The `KEY=value` subset every other service in this repo relies on: comments,
/// blank lines, an optional `export` prefix, and single or double quotes.
/// Deliberately not a full shell parser -- interpolation would make the same
/// file mean different things to the Go, Python and Rust readers.
fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            continue;
        }
        let value = value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value[1..value.len() - 1].to_string()
        } else {
            // An unquoted trailing comment is a comment in every dotenv dialect
            // this repo uses.
            match value.split_once(" #") {
                Some((v, _)) => v.trim().to_string(),
                None => value.to_string(),
            }
        };
        out.push((key.to_string(), value));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The `.env` walker's per-directory check, which is what the walk repeats.
    fn dotenv_in(dir: &Path) -> Option<PathBuf> {
        let candidate = dir.join(".env");
        candidate.is_file().then_some(candidate)
    }

    #[test]
    fn parses_the_dotenv_subset_the_repo_uses() {
        let text = "\
# a comment
CLASSG_DETECTION_ENDPOINT=tcp://127.0.0.1:5556

export CLASSG_SDR_SENSOR_ID=sdr-1
CLASSG_SDR_DUMP1090_ADDR=\"10.0.0.5:30003\"
CLASSG_DETECTION_TOPIC='detection.'
CLASSG_SDR_ZMQ_HWM=500 # keep it small on the Pi
NOT A SETTING
=novalue
";
        let parsed = parse_dotenv(text);
        assert_eq!(
            parsed,
            vec![
                (
                    "CLASSG_DETECTION_ENDPOINT".to_string(),
                    "tcp://127.0.0.1:5556".to_string()
                ),
                ("CLASSG_SDR_SENSOR_ID".to_string(), "sdr-1".to_string()),
                (
                    "CLASSG_SDR_DUMP1090_ADDR".to_string(),
                    "10.0.0.5:30003".to_string()
                ),
                (
                    "CLASSG_DETECTION_TOPIC".to_string(),
                    "detection.".to_string()
                ),
                ("CLASSG_SDR_ZMQ_HWM".to_string(), "500".to_string()),
            ]
        );
    }

    #[test]
    fn a_missing_dotenv_is_not_an_error() {
        assert!(dotenv_in(Path::new("/definitely/not/here")).is_none());
    }

    fn resolve(pairs: &[(&str, &str)], from_file: &[String]) -> Result<Settings, Vec<String>> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Settings::resolve(
            &move |key| {
                owned
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v.to_string())
            },
            from_file,
        )
    }

    fn source_of(settings: &Settings, key: &str) -> Source {
        settings
            .report()
            .iter()
            .find(|(k, _, _)| *k == key)
            .unwrap_or_else(|| panic!("{key} is not in the report"))
            .2
    }

    /// A unit with nothing set must come up pointed at the documented
    /// loopback bus and dump1090's default port.
    #[test]
    fn bare_defaults_are_the_documented_ones() {
        let settings = resolve(&[], &[]).expect("bare defaults must be valid");
        assert_eq!(settings.sensor_id, "sdr-0");
        assert_eq!(settings.dump1090, DEFAULT_DUMP1090);
        assert_eq!(settings.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(settings.detection_topic, "detection.");
        assert_eq!(settings.heartbeat_topic, "heartbeat.");
        assert_eq!(settings.hwm, 1000);
        assert_eq!(settings.heartbeat_interval, Duration::from_secs(10));
        assert_eq!(settings.reconnect_max, Duration::from_secs(30));
        assert!(settings
            .report()
            .iter()
            .all(|(_, _, source)| *source == Source::Default));
    }

    /// `connect`, not the Wi-Fi sensor's `bind`: two PUB sockets cannot bind
    /// one endpoint, and the Wi-Fi sensor already holds it.
    #[test]
    fn the_socket_mode_default_lets_a_second_sensor_exist() {
        assert_eq!(resolve(&[], &[]).unwrap().socket_mode, SocketMode::Connect);
    }

    /// ADR-0007's actual requirement: not that values may come from several
    /// places, but that you can tell which place each one came from.
    #[test]
    fn every_value_reports_where_it_came_from() {
        let settings = resolve(
            &[
                ("CLASSG_SDR_DUMP1090_ADDR", "10.0.0.5:30003"),
                ("CLASSG_SDR_SOCKET_MODE", "bind"),
            ],
            &["CLASSG_SDR_SOCKET_MODE".to_string()],
        )
        .unwrap();
        assert_eq!(settings.dump1090, "10.0.0.5:30003");
        assert_eq!(settings.socket_mode, SocketMode::Bind);
        assert_eq!(
            source_of(&settings, "CLASSG_SDR_DUMP1090_ADDR"),
            Source::Env
        );
        assert_eq!(
            source_of(&settings, "CLASSG_SDR_SOCKET_MODE"),
            Source::EnvFile
        );
        assert_eq!(
            source_of(&settings, "CLASSG_HEARTBEAT_TOPIC"),
            Source::Default
        );
    }

    /// Every problem at once. An operator fixing a misconfigured unit one
    /// restart at a time is the failure mode this avoids.
    #[test]
    fn all_configuration_errors_are_reported_together() {
        let errors = resolve(
            &[
                ("CLASSG_SDR_SOCKET_MODE", "dial"),
                ("CLASSG_SDR_ZMQ_HWM", "-1"),
                ("CLASSG_SDR_HEARTBEAT_S", "0"),
                ("CLASSG_SDR_RECONNECT_MAX_S", "soon"),
            ],
            &[],
        )
        .unwrap_err();
        assert_eq!(errors.len(), 4, "{errors:?}");
        assert!(errors[0].contains("CLASSG_SDR_SOCKET_MODE"), "{errors:?}");
        assert!(errors[1].contains("CLASSG_SDR_ZMQ_HWM"), "{errors:?}");
        assert!(errors[2].contains("CLASSG_SDR_HEARTBEAT_S"), "{errors:?}");
        assert!(
            errors[3].contains("CLASSG_SDR_RECONNECT_MAX_S"),
            "{errors:?}"
        );
    }

    /// An empty or whitespace-only value is a variable someone meant to unset,
    /// not a request for an empty sensor ID.
    #[test]
    fn a_blank_override_falls_back_to_the_default() {
        let settings = resolve(
            &[
                ("CLASSG_SDR_SENSOR_ID", "   "),
                ("CLASSG_DETECTION_ENDPOINT", ""),
            ],
            &[],
        )
        .unwrap();
        assert_eq!(settings.sensor_id, "sdr-0");
        assert_eq!(settings.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(
            source_of(&settings, "CLASSG_SDR_SENSOR_ID"),
            Source::Default
        );
    }

    /// The startup report is the operator-facing contract, so a setting that
    /// stops appearing in it is a regression even though nothing else breaks.
    #[test]
    fn the_report_covers_every_documented_setting() {
        let settings = resolve(&[], &[]).unwrap();
        let keys: Vec<&str> = settings.report().iter().map(|(k, _, _)| *k).collect();
        assert_eq!(
            keys,
            vec![
                "CLASSG_SDR_SENSOR_ID",
                "CLASSG_SDR_DUMP1090_ADDR",
                "CLASSG_DETECTION_ENDPOINT",
                "CLASSG_DETECTION_TOPIC",
                "CLASSG_HEARTBEAT_TOPIC",
                "CLASSG_SDR_SOCKET_MODE",
                "CLASSG_SDR_ZMQ_HWM",
                "CLASSG_SDR_HEARTBEAT_S",
                "CLASSG_SDR_RECONNECT_MAX_S",
            ]
        );
    }
}

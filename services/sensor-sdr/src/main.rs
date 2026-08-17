//! ClassG SDR sensor.
//!
//! Scope (ADR-0004): sub-2 GHz only. This sensor does NOT and CANNOT detect DJI
//! drones -- OcuSync is at 2.4/5.8 GHz, above the RTL-SDR V4's 1.766 GHz ceiling.
//! Its job is ADS-B airspace context and the control-link/FPV bands, which is
//! where non-Remote-ID aircraft show up.

mod adsb;
mod bus;
mod clock;
mod config;
mod detection;
mod sbs;
// SdrSource, SampleBuffer and NoiseFloor are the scaffolding the *sweep* loop
// will consume in Milestone 3. The ADS-B loop does not touch either module --
// ADR-0008 gives the radio to dump1090 -- so they are still exercised only by
// their own tests. The crate-wide allow that used to cover them is gone now
// that a capture loop exists: a dead_code warning anywhere else means something
// genuinely went unused.
#[allow(dead_code)]
mod source;
#[allow(dead_code)]
mod sweep;
mod ulid;
mod zmtp;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use source::{RTLSDR_MAX_HZ, RTLSDR_STABLE_SAMPLE_RATE};
use sweep::{plan_sweep, BAND_PLANS};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Print one schema-shaped detection and exit. This is how the cross-language
    // contract gets checked for Rust: the CI `schemas` job validates this output
    // against schemas/detection.schema.json, closing the gap that left this the
    // only one of the four services whose wire format nothing verified.
    if args.iter().any(|a| a == "--emit-sample-detection") {
        match serde_json::to_string_pretty(&detection::sample_detection()) {
            Ok(json) => println!("{json}"),
            Err(err) => {
                eprintln!("serialising the sample detection failed: {err}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|a| a == "adsb" || a == "--adsb") {
        std::process::exit(run_adsb());
    }

    if args.iter().any(|a| a == "-h" || a == "--help") {
        usage();
        return;
    }

    banner();
    eprintln!(
        "\nNo capture loop selected. `classg-sensor-sdr adsb` runs the ADS-B ingest;\n\
         the sweep engine is Milestone 3 -- see docs/planning/roadmap.md."
    );
    std::process::exit(1);
}

fn usage() {
    println!("classg-sensor-sdr {}\n", env!("CARGO_PKG_VERSION"));
    println!("  adsb                      consume dump1090's SBS-1 stream, publish Class D");
    println!("  --emit-sample-detection   print one schema-shaped detection and exit");
    println!("  (no argument)             print the band plan and the tuner limits");
    println!("\nConfiguration is environment-driven (ADR-0007); `adsb` prints every");
    println!("effective value and where it came from at startup.");
}

/// Milestone 2: dump1090's SBS-1 stream in, Class D detections on the bus out.
///
/// Milestone 3 -- the sweep engine -- is still to come: retune, FFT, per-bin
/// power against `NoiseFloor::threshold()`, burst cadence against
/// `CONTROL_LINK_RATES_HZ`, and Class E/F with `signal_features` populated.
/// Envelope characterisation ONLY; never demodulate payload or video -- see the
/// header comment in sweep.rs and docs/research/06-legal-and-ethics.md.
fn run_adsb() -> i32 {
    let from_file = config::load_env_file();
    let settings = match config::Settings::from_env(&from_file) {
        Ok(s) => s,
        Err(errors) => {
            for err in errors {
                eprintln!("{} config: {err}", clock::now_rfc3339());
            }
            // Configuration is wrong in a way no amount of retrying fixes.
            // Exiting lets systemd's restart backoff surface it.
            return 2;
        }
    };

    println!("ClassG sensor-sdr v{} -- ADS-B", env!("CARGO_PKG_VERSION"));
    println!("Radio ownership: dump1090 (ADR-0008). This process opens no SDR.");
    // ADR-0007's actual requirement: not that values come from one place, but
    // that you can see which place each one came from.
    for (key, value, source) in settings.report() {
        println!("  {key:<28} {value:<24} ({source})");
    }

    let publisher = match bus::DetectionPublisher::open(
        &settings.endpoint,
        settings.socket_mode,
        settings.hwm,
        settings.reconnect_max,
        &settings.sensor_id,
        &settings.detection_topic,
        &settings.heartbeat_topic,
    ) {
        Ok(p) => p,
        Err(err) => {
            eprintln!(
                "{} bus: cannot open {} in {} mode: {err}",
                clock::now_rfc3339(),
                settings.endpoint,
                settings.socket_mode.as_str()
            );
            if settings.socket_mode == zmtp::SocketMode::Bind {
                eprintln!(
                    "  Only one publisher can bind an endpoint. If sensor-wifi already holds it, \
                     set CLASSG_SDR_SOCKET_MODE=connect and put fusion in listen mode."
                );
            }
            // Nothing to degrade to: a bus that does not exist cannot carry the
            // heartbeat that would report the degradation.
            return 1;
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    let cfg = adsb::Config {
        sensor_id: settings.sensor_id.clone(),
        address: settings.dump1090.clone(),
        heartbeat_interval: settings.heartbeat_interval,
        reconnect_max: settings.reconnect_max,
    };

    let stats = adsb::run(&cfg, &publisher, &stop);
    // Only reachable if `stop` is ever set; today SIGTERM ends the process
    // directly, which is fine for a fire-and-forget PUB socket with nothing to
    // flush. Kept because the loop is written to be stoppable and silently
    // dropping its summary would be worse than printing it.
    println!(
        "read {} lines, published {}, dropped {}, {} distinct aircraft, {} reconnects",
        stats.lines_read,
        stats.parsed,
        stats.dropped,
        stats.icaos.len(),
        stats.reconnects
    );
    let _ = stop.load(Ordering::Relaxed);
    0
}

fn banner() {
    println!("ClassG sensor-sdr v{}", env!("CARGO_PKG_VERSION"));
    println!(
        "Tuner ceiling: {:.3} GHz | stable sample rate: {:.1} MSPS",
        RTLSDR_MAX_HZ as f64 / 1e9,
        RTLSDR_STABLE_SAMPLE_RATE as f64 / 1e6
    );
    println!("Scope: sub-2 GHz only. DJI OcuSync (2.4/5.8 GHz) is out of reach -- ADR-0004.\n");

    println!("Band plan:");
    for band in BAND_PLANS {
        let steps = plan_sweep(band, 0.2);
        let dwell_ms = 100;
        println!(
            "  {:<10} class {}  {:>7.1}-{:>7.1} MHz  {:>3} steps  ~{:.1}s/sweep",
            band.name,
            band.class,
            band.start_hz as f64 / 1e6,
            band.stop_hz as f64 / 1e6,
            steps.len(),
            (steps.len() * dwell_ms) as f64 / 1000.0
        );
        println!("             {}", band.note);
    }
}

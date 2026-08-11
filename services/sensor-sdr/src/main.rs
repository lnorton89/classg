//! ClassG SDR sensor.
//!
//! Scope (ADR-0004): sub-2 GHz only. This sensor does NOT and CANNOT detect DJI
//! drones -- OcuSync is at 2.4/5.8 GHz, above the RTL-SDR V4's 1.766 GHz ceiling.
//! Its job is ADS-B airspace context and the control-link/FPV bands, which is
//! where non-Remote-ID aircraft show up.

// The SdrSource trait, SampleBuffer, and NoiseFloor are the scaffolding the
// capture loop will consume in Milestones 2-3. They are exercised by unit tests
// but not yet called from main, so the crate would otherwise be full of
// dead_code warnings that drown out real ones.
//
// REMOVE THIS once the capture loop lands -- at that point a dead_code warning
// means something genuinely went unused.
#![allow(dead_code)]

mod detection;
mod sbs;
mod source;
mod sweep;

use source::{RTLSDR_MAX_HZ, RTLSDR_STABLE_SAMPLE_RATE};
use sweep::{plan_sweep, BAND_PLANS};

fn main() {
    // Print one schema-shaped detection and exit. This is how the cross-language
    // contract gets checked for Rust: the CI `schemas` job validates this output
    // against schemas/detection.schema.json, closing the gap that left this the
    // only one of the four services whose wire format nothing verified.
    if std::env::args().any(|a| a == "--emit-sample-detection") {
        match serde_json::to_string_pretty(&detection::sample_detection()) {
            Ok(json) => println!("{json}"),
            Err(err) => {
                eprintln!("serialising the sample detection failed: {err}");
                std::process::exit(1);
            }
        }
        return;
    }

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

    // NOTE (Milestone 2/3): the capture loop is not implemented yet.
    //
    // Milestone 2 -- ADS-B:
    //   spawn dump1090 (or link librtlsdr directly), consume its output, emit
    //   Class D detections. Highest value per unit of effort: gives airspace
    //   context AND false-positive suppression for Classes E/F.
    //
    // Milestone 3 -- sweep:
    //   for each step: retune -> read samples -> FFT -> per-bin power ->
    //   compare against NoiseFloor::threshold() -> on excess, characterise burst
    //   cadence against CONTROL_LINK_RATES_HZ -> emit Class E/F with
    //   signal_features populated.
    //
    //   Envelope characterisation ONLY. Never demodulate payload or video --
    //   see the header comment in sweep.rs and docs/research/06-legal-and-ethics.md.
    //
    // Both must emit a heartbeat on the bus regardless of detections, so a wedged
    // sensor is distinguishable from a quiet sky (ADR-0003).
    eprintln!(
        "\nCapture loop not implemented -- see Milestones 2 and 3 in docs/planning/roadmap.md"
    );
    std::process::exit(1);
}

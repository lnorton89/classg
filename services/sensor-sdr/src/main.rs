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
mod spectrum;
#[allow(dead_code)]
mod sweep;
#[allow(dead_code)]
mod sweepdoc;
// The real radio, behind a feature because linking librtlsdr would stop the
// crate building on the CI runner, which installs no system packages.
#[cfg(feature = "rtlsdr")]
#[allow(dead_code)]
mod rtlsdr;
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
    // Same contract check, for the other document this sensor puts on the bus.
    // The heartbeat schema exists to stop the two sensors disagreeing about the
    // timestamp format, and only one of them was being held to it.
    if args.iter().any(|a| a == "--emit-sample-heartbeat") {
        match serde_json::to_string_pretty(&bus::sample_heartbeat()) {
            Ok(json) => println!("{json}"),
            Err(err) => {
                eprintln!("serialising the sample heartbeat failed: {err}");
                std::process::exit(1);
            }
        }
        return;
    }

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

    if args.iter().any(|a| a == "probe") {
        std::process::exit(run_probe(args.iter().any(|a| a == "--open")));
    }

    // The band plan without a radio. The api needs to offer bands before an
    // operator has picked one, and hardcoding the list in Go would let it drift
    // from BAND_PLANS silently -- the same trap two sensor-detail allowlists
    // would have been.
    if args.iter().any(|a| a == "bands") {
        std::process::exit(run_bands(args.iter().any(|a| a == "--json")));
    }

    if args.iter().any(|a| a == "sweep") {
        let band = args
            .iter()
            .position(|a| a == "--band")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| "ism_915".to_string());
        std::process::exit(run_sweep(&band, args.iter().any(|a| a == "--json")));
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
    println!("  probe [--open]            list attached SDRs; --open tunes and reads a burst");
    println!("  bands [--json]            list the band plan; needs no radio");
    println!("  sweep [--band NAME]       measure a band's spectrum and noise floor");
    println!("       [--json]             emit the whole measurement, bins included");
    println!("  --emit-sample-detection   print one schema-shaped detection and exit");
    println!("  --emit-sample-heartbeat   print one schema-shaped heartbeat and exit");
    println!("  (no argument)             print the band plan and the tuner limits");
    println!("\nConfiguration is environment-driven (ADR-0007); `adsb` prints every");
    println!("effective value and where it came from at startup.");
}

/// Enumerate without opening.
///
/// Counting and naming devices touches no USB endpoint, so this answers "is the
/// radio there" while dump1090 holds it -- which on this unit it always does
/// (ADR-0008). Opening here instead would fail with a libusb code every time
/// the system was working correctly.
#[cfg(feature = "rtlsdr")]
fn run_probe(open: bool) -> i32 {
    use source::SdrSource;

    let count = rtlsdr::device_count();
    if count == 0 {
        eprintln!("no SDR found.");
        eprintln!("{}", source::SdrError::DeviceNotFound);
        return 1;
    }
    println!("{count} SDR(s):");
    for i in 0..count {
        let name = rtlsdr::device_name(i).unwrap_or_else(|| "<unnamed>".into());
        println!("  {i}: {name}");
    }
    println!(
        "\ntunable {:.3}-{:.3} GHz. DJI at 2.4/5.8 GHz is above this ceiling and always will be.",
        source::RTLSDR_MIN_HZ as f64 / 1e9,
        RTLSDR_MAX_HZ as f64 / 1e9
    );

    if !open {
        println!("\n(enumeration only; `probe --open` tunes and reads, and needs the radio)");
        return 0;
    }

    // 915 MHz ISM: the band Milestone 3 exists for, and the one where an
    // unmodified unit is most likely to see something at all.
    const PROBE_HZ: u64 = 915_000_000;

    let mut sdr = match rtlsdr::RtlSdrSource::open(0) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("\n{err}");
            return 1;
        }
    };
    if let Err(err) = sdr.set_center_freq(PROBE_HZ) {
        eprintln!("\n{err}");
        return 1;
    }
    // Mid-scale. Enough to see the noise floor move without overloading an
    // 8-bit ADC, which is the classic way to make weak signals disappear.
    if let Err(err) = sdr.set_gain(200) {
        eprintln!("\n{err}");
        return 1;
    }

    match sdr.read_samples(16_384) {
        Ok(buf) => {
            // Envelope only -- mean power and peak magnitude. Nothing here
            // demodulates, and nothing here may: see sweep.rs and
            // docs/research/06-legal-and-ethics.md.
            let n = buf.iq.len().max(1) as f32;
            let mean_pow: f32 = buf.iq.iter().map(|c| c.norm_sqr()).sum::<f32>() / n;
            let peak = buf.iq.iter().map(|c| c.norm()).fold(0.0f32, f32::max);
            println!(
                "\nread {} samples at {:.3} MHz, {} sps",
                buf.iq.len(),
                buf.center_hz as f64 / 1e6,
                buf.sample_rate
            );
            println!(
                "mean power {:.1} dBFS, peak magnitude {:.3}",
                10.0 * mean_pow.max(f32::MIN_POSITIVE).log10(),
                peak
            );
            0
        }
        Err(err) => {
            eprintln!("\n{err}");
            1
        }
    }
}

/// Measure a band: retune across it, transform each slice, report where the
/// energy is and what the floor under it looks like.
///
/// This is the measurement half of Milestone 3 and stops deliberately short of
/// the detector. Classifying a burst train as ELRS needs a transmitter to
/// validate against, and the roadmap is explicit that an unvalidated detector
/// is worse than none -- so this reports what it measured and claims nothing
/// about what produced it.
///
/// Envelope only. See spectrum.rs.
#[cfg(feature = "rtlsdr")]
fn run_sweep(band_name: &str, json: bool) -> i32 {
    use source::SdrSource;

    let Some(band) = sweep::BAND_PLANS.iter().find(|b| b.name == band_name) else {
        eprintln!("no band called {band_name:?}. Known bands:");
        for b in sweep::BAND_PLANS {
            eprintln!(
                "  {:<9} {:.3}-{:.3} MHz",
                b.name,
                b.start_hz as f64 / 1e6,
                b.stop_hz as f64 / 1e6
            );
        }
        return 2;
    };

    // 20% overlap: the outer fifth of the passband rolls off, so abutting steps
    // exactly would leave a blind notch at every boundary.
    let steps = sweep::plan_sweep(band, 0.2);

    // Progress goes to stderr, always. --json puts one parseable document on
    // stdout and nothing else; interleaving a human line into it would make the
    // api's decoder fail on a working sweep.
    eprintln!(
        "{} -- {:.3}-{:.3} MHz in {} steps",
        band.name,
        band.start_hz as f64 / 1e6,
        band.stop_hz as f64 / 1e6,
        steps.len()
    );
    eprintln!("{}\n", band.note);

    let mut sdr = match rtlsdr::RtlSdrSource::open(0) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };
    const GAIN_TENTH_DB: i32 = 200;
    if let Err(err) = sdr.set_gain(GAIN_TENTH_DB) {
        eprintln!("{err}");
        return 1;
    }

    const FFT: usize = 1024;
    // Eight segments per step: enough averaging to stop the floor wandering
    // several dB between reads, which is what a single transform of noise does.
    const SAMPLES: usize = FFT * 8;
    const THRESHOLD_OVER_FLOOR_DB: f32 = 10.0;

    let mut floor = sweep::NoiseFloor::new(steps.len() * FFT);
    let mut step_docs: Vec<sweepdoc::SweepStepDoc> = Vec::with_capacity(steps.len());
    let mut short_reads: Vec<u64> = Vec::new();

    for step in &steps {
        if let Err(err) = sdr.set_center_freq(step.center_hz) {
            eprintln!("{err}");
            return 1;
        }
        let buf = match sdr.read_samples(SAMPLES) {
            Ok(b) => b,
            Err(err) => {
                eprintln!("{err}");
                return 1;
            }
        };
        let Some(spec) = spectrum::power_spectrum(&buf.iq, step.center_hz, buf.sample_rate, FFT)
        else {
            eprintln!("short read at {:.3} MHz", step.center_hz as f64 / 1e6);
            short_reads.push(step.center_hz);
            continue;
        };

        for &db in &spec.bins_db {
            floor.push(db);
        }
        // Excluding DC: the radio's own LO lands at the tuned frequency, and
        // trusting the raw peak reported a detection at the centre of all
        // fourteen steps the first time this ran against real spectrum.
        let peak = spec.peak_excluding_dc(spectrum::DC_GUARD_BINS);
        if let Some((bin, db)) = peak {
            eprintln!(
                "  {:>9.3} MHz  peak {:>7.1} dBFS at {:>9.3} MHz",
                step.center_hz as f64 / 1e6,
                db,
                spec.bin_hz(bin) / 1e6
            );
        }

        step_docs.push(sweepdoc::SweepStepDoc {
            center_hz: step.center_hz,
            first_bin_hz: spec.bin_hz(0),
            bin_width_hz: buf.sample_rate as f64 / FFT as f64,
            peak_hz: peak.map(|(bin, _)| spec.bin_hz(bin)),
            peak_dbfs: peak.map(|(_, db)| sweepdoc::round_db(db)),
            bins_dbfs: spec
                .bins_db
                .iter()
                .copied()
                .map(sweepdoc::round_db)
                .collect(),
        });
    }

    let doc = sweepdoc::SweepDoc {
        band: band.name.to_string(),
        class: band.class.to_string(),
        note: band.note.to_string(),
        start_hz: band.start_hz,
        stop_hz: band.stop_hz,
        sample_rate: RTLSDR_STABLE_SAMPLE_RATE,
        fft_size: FFT,
        dc_guard_bins: spectrum::DC_GUARD_BINS,
        gain_tenth_db: GAIN_TENTH_DB,
        noise_floor_dbfs: floor.median(),
        threshold_dbfs: floor.threshold(THRESHOLD_OVER_FLOOR_DB),
        threshold_over_floor_db: THRESHOLD_OVER_FLOOR_DB,
        steps: step_docs,
        short_reads,
    };

    if doc.noise_floor_dbfs.is_none() {
        eprintln!("no spectrum measured");
        return 1;
    }

    if json {
        match serde_json::to_string(&doc) {
            Ok(s) => {
                println!("{s}");
                return 0;
            }
            Err(err) => {
                eprintln!("serialising the sweep failed: {err}");
                return 1;
            }
        }
    }

    print_sweep_summary(&doc);
    0
}

/// The human tail of a sweep: floor, threshold, and which step peaks cleared it.
///
/// Split out so the JSON path and the terminal path report the same measurement
/// rather than two loops that can drift.
#[cfg(feature = "rtlsdr")]
fn print_sweep_summary(doc: &sweepdoc::SweepDoc) {
    let (Some(median), Some(threshold)) = (doc.noise_floor_dbfs, doc.threshold_dbfs) else {
        return;
    };
    println!(
        "\nnoise floor {median:.1} dBFS (median), +{:.0} dB threshold {threshold:.1} dBFS",
        doc.threshold_over_floor_db
    );

    let above: Vec<_> = doc
        .steps
        .iter()
        .filter_map(|s| Some((s.peak_hz?, s.peak_dbfs?)))
        .filter(|(_, db)| *db > threshold)
        .collect();

    if above.is_empty() {
        println!("nothing above threshold in this band right now.");
    } else {
        println!("{} step peak(s) above threshold:", above.len());
        for (hz, db) in above {
            println!("  {:>9.3} MHz  {:>7.1} dBFS", hz / 1e6, db);
        }
    }
    if !doc.short_reads.is_empty() {
        println!(
            "{} step(s) read short and were not measured -- the band has holes at:",
            doc.short_reads.len()
        );
        for hz in &doc.short_reads {
            println!("  {:>9.3} MHz", *hz as f64 / 1e6);
        }
    }
    println!(
        "\nEnergy only. Nothing here identifies a transmitter -- cadence analysis\nagainst CONTROL_LINK_RATES_HZ is Milestone 3's detector and needs a test\ntransmitter to validate."
    );
}

/// The band plan, with no radio involved.
///
/// `--json` is what the api reads to populate its band picker. Splitting the
/// list out of `banner()` means the api never has to parse a human table, and
/// never has to keep its own copy of BAND_PLANS in Go.
fn run_bands(json: bool) -> i32 {
    if json {
        let bands: Vec<_> = BAND_PLANS
            .iter()
            .map(|b| {
                serde_json::json!({
                    "name": b.name,
                    "class": b.class.to_string(),
                    "note": b.note,
                    "start_hz": b.start_hz,
                    "stop_hz": b.stop_hz,
                    "steps": plan_sweep(b, 0.2).len(),
                })
            })
            .collect();
        match serde_json::to_string(&serde_json::json!({ "bands": bands })) {
            Ok(s) => println!("{s}"),
            Err(err) => {
                eprintln!("serialising the band plan failed: {err}");
                return 1;
            }
        }
        return 0;
    }

    for b in BAND_PLANS {
        println!(
            "{:<10} class {}  {:>8.3}-{:>8.3} MHz  {:>3} steps",
            b.name,
            b.class,
            b.start_hz as f64 / 1e6,
            b.stop_hz as f64 / 1e6,
            plan_sweep(b, 0.2).len(),
        );
        println!("           {}", b.note);
    }
    0
}

#[cfg(not(feature = "rtlsdr"))]
fn run_sweep(_band: &str, _json: bool) -> i32 {
    eprintln!(
        "built without the `rtlsdr` feature, so this binary cannot talk to a radio.\n\
         Rebuild with: cargo build --release --features rtlsdr"
    );
    2
}

#[cfg(not(feature = "rtlsdr"))]
fn run_probe(_open: bool) -> i32 {
    eprintln!(
        "built without the `rtlsdr` feature, so this binary cannot talk to a radio.\n\
         Rebuild with: cargo build --release --features rtlsdr\n\
         It is off by default because linking librtlsdr would stop the crate\n\
         building where that library is absent, CI included."
    );
    2
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

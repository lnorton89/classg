//! The ADS-B ingest loop: dump1090's SBS-1 stream in, Class D detections out.
//!
//! ADR-0008 settled the shape of this: dump1090 owns the radio, has already
//! checked the Mode S CRC and resolved CPR positions, and we consume its decoded
//! output on TCP 30003. [`crate::sbs`] does the translation. This module is
//! everything around it -- the socket, the reconnects, the counters, and the
//! heartbeat that makes a quiet sky distinguishable from a dead decoder.
//!
//! Nothing here transmits and nothing here demodulates. It reads a TCP stream
//! someone else produced.
//!
//! # Failure is the normal case
//!
//! ADR-0003 makes the degradation rules explicit, and every one of them shows up
//! here rather than as a panic:
//!
//! | What happens | What this does |
//! |---|---|
//! | dump1090 not running | connect refuses; report unhealthy, retry with bounded backoff |
//! | dump1090 dies mid-stream | read hits EOF; reconnect from the top, count it |
//! | the host does not resolve | same path as a refused connection, with the resolver's message |
//! | no aircraft in range | **healthy**; the sky is allowed to be empty |
//! | a line that will not parse | counted, not logged per-line, never fatal |
//! | no SDR fitted at all | never touched here -- dump1090 owns the radio |
//!
//! The last two rows are the ones that would be easy to get wrong. Treating a
//! quiet band as unhealthy would make an empty sky look like a fault; treating a
//! parse failure as fatal would hand a denial of service to anything that can
//! write a line to port 30003.

use std::collections::BTreeSet;
#[cfg(test)]
use std::io::Read;
use std::io::{BufRead, BufReader, ErrorKind};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::bus::Bus;
use crate::clock;
use crate::sbs::{self, ParseError};
use crate::ulid::UlidFactory;

/// How long a read may block before the loop comes up for air. This is what
/// keeps heartbeats on schedule through a silent stream without a second
/// thread; it is not a staleness threshold.
const READ_TIMEOUT: Duration = Duration::from_millis(500);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RECONNECT_MIN: Duration = Duration::from_millis(500);

/// An SBS-1 record is ~100 bytes. Anything approaching this is a peer that has
/// stopped sending newlines, and buffering it without limit would be the memory
/// exhaustion version of the same denial of service the parser already guards
/// against.
const MAX_LINE_BYTES: usize = 64 * 1024;

pub struct Config {
    pub sensor_id: String,
    pub address: String,
    pub heartbeat_interval: Duration,
    pub reconnect_max: Duration,
}

/// Everything the heartbeat reports, and the reason it is worth reporting.
#[derive(Debug, Default)]
pub struct Stats {
    /// Lines pulled off the socket, parseable or not.
    pub lines_read: u64,
    /// Lines that became a detection.
    pub parsed: u64,
    /// Lines that did not. Expected and mostly benign -- STA/ID/AIR session
    /// records are bookkeeping, not observations -- so this is a rate to watch,
    /// not an error count.
    pub unparsed: u64,
    /// Detections the bus refused because its queue was full.
    pub dropped: u64,
    /// Reconnects since start. A number that keeps climbing is a dump1090 that
    /// keeps dying, which looks identical to a quiet sky in the detection
    /// stream alone.
    pub reconnects: u64,
    /// Distinct ICAO addresses seen. The single most useful "is this working"
    /// number: one aircraft producing a hundred messages and a hundred aircraft
    /// producing one each are very different situations.
    pub icaos: BTreeSet<String>,
    pub connected: bool,
    pub last_error: Option<String>,
    last_message: Option<Instant>,
}

impl Stats {
    fn seconds_since_message(&self) -> Option<f64> {
        self.last_message.map(|t| t.elapsed().as_secs_f64())
    }

    fn detail(&self, address: &str, subscribers: usize) -> serde_json::Value {
        let mut detail = json!({
            "source": address,
            "connected": self.connected,
            "messages_read": self.lines_read,
            "parsed": self.parsed,
            "unparsed": self.unparsed,
            "reconnects": self.reconnects,
            "icaos": self.icaos.len(),
            "subscribers": subscribers,
            // Null until the first message: "no data yet" and "data stopped an
            // hour ago" are different states and must not share a value.
            "seconds_since_message": self.seconds_since_message(),
        });
        if let Some(err) = &self.last_error {
            detail["error"] = json!(err);
        }
        detail
    }
}

/// Run until `stop` is set.
///
/// Returns the accumulated stats, which the caller prints on the way out. It
/// never returns an error: there is no failure here that is not a degraded
/// state, which is exactly the point of ADR-0003.
pub fn run<B: Bus>(cfg: &Config, bus: &B, stop: &AtomicBool) -> Stats {
    let mut stats = Stats::default();
    let mut ulid = UlidFactory::new();
    let mut backoff = RECONNECT_MIN;
    // Fires immediately: a sensor that starts and then says nothing for ten
    // seconds is indistinguishable from one that failed to start.
    let mut next_heartbeat = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        match connect(&cfg.address) {
            Ok(stream) => {
                log(&format!("connected to dump1090 at {}", cfg.address));
                stats.connected = true;
                stats.last_error = None;
                backoff = RECONNECT_MIN;
                beat(cfg, bus, &mut stats, &mut next_heartbeat, true);

                pump(
                    cfg,
                    bus,
                    &mut stats,
                    &mut ulid,
                    &mut next_heartbeat,
                    stream,
                    stop,
                );

                stats.connected = false;
                if !stop.load(Ordering::Relaxed) {
                    stats.reconnects += 1;
                    log(&format!(
                        "dump1090 stream ended after {} messages; reconnecting",
                        stats.lines_read
                    ));
                }
            }
            Err(err) => {
                let message = err.to_string();
                // Once per distinct cause. dump1090 not being up yet is the
                // normal state during boot and must not fill the journal, but a
                // *change* of reason is worth seeing.
                if stats.last_error.as_deref() != Some(message.as_str()) {
                    log(&format!(
                        "dump1090 at {} unavailable: {message}",
                        cfg.address
                    ));
                }
                stats.connected = false;
                stats.last_error = Some(message);
            }
        }

        if stop.load(Ordering::Relaxed) {
            break;
        }
        // Heartbeats continue through the backoff wait. Losing them here would
        // lose them in precisely the situation they exist for.
        beat(cfg, bus, &mut stats, &mut next_heartbeat, false);
        sleep_until(backoff, cfg, bus, &mut stats, &mut next_heartbeat, stop);
        backoff = (backoff * 2).min(cfg.reconnect_max.max(RECONNECT_MIN));
    }

    let healthy = stats.connected;
    beat(cfg, bus, &mut stats, &mut next_heartbeat, healthy);
    stats
}

/// Read lines until the stream ends or `stop` is set.
fn pump<B: Bus>(
    cfg: &Config,
    bus: &B,
    stats: &mut Stats,
    ulid: &mut UlidFactory,
    next_heartbeat: &mut Instant,
    stream: TcpStream,
    stop: &AtomicBool,
) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let mut oversized = false;

    while !stop.load(Ordering::Relaxed) {
        beat(cfg, bus, stats, next_heartbeat, true);

        // `fill_buf` rather than `read_line`: with a read timeout set, a
        // `read_line` that times out mid-line leaves the caller's buffer in a
        // documented-as-unspecified state, which would corrupt whichever record
        // straddled the timeout. `fill_buf` consumes nothing on error.
        let chunk = match reader.fill_buf() {
            Ok([]) => return, // clean EOF: dump1090 exited
            Ok(buf) => buf.to_vec(),
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err)
                if err.kind() == ErrorKind::WouldBlock || err.kind() == ErrorKind::TimedOut =>
            {
                continue
            }
            Err(err) => {
                stats.last_error = Some(err.to_string());
                return;
            }
        };
        reader.consume(chunk.len());

        for byte in chunk {
            if byte == b'\n' {
                if oversized {
                    // The tail of a line we already gave up on.
                    stats.lines_read += 1;
                    stats.unparsed += 1;
                    oversized = false;
                } else {
                    handle_line(cfg, bus, stats, ulid, &line);
                }
                line.clear();
                continue;
            }
            if byte == b'\r' {
                continue;
            }
            if line.len() >= MAX_LINE_BYTES {
                if !oversized {
                    log("discarding an SBS line over 64 KiB; dump1090 is not sending newlines");
                    oversized = true;
                    line.clear();
                }
                continue;
            }
            line.push(byte);
        }
    }
}

fn handle_line<B: Bus>(
    cfg: &Config,
    bus: &B,
    stats: &mut Stats,
    ulid: &mut UlidFactory,
    line: &[u8],
) {
    stats.lines_read += 1;
    stats.last_message = Some(Instant::now());

    // dump1090 writes ASCII, but the socket carries whatever is on it. Lossy
    // decoding keeps a stray byte from ending the stream.
    let text = String::from_utf8_lossy(line);
    let now = clock::epoch_ms();
    let mut detection = match sbs::parse_line(&text, &cfg.sensor_id, &clock::rfc3339_ms(now)) {
        Ok(d) => d,
        Err(err) => {
            stats.unparsed += 1;
            // Session bookkeeping is the overwhelming majority of what fails to
            // parse and it is not a fault, so this is sampled rather than
            // logged per line -- the same shape as the drop warning in
            // classg_wifi/bus.py.
            if stats.unparsed % 1_000 == 1 && !matches!(err, ParseError::NotAnAircraftMessage) {
                log(&format!(
                    "{} unparsed SBS lines so far; most recent: {err:?}",
                    stats.unparsed
                ));
            }
            return;
        }
    };

    detection.detection_id = ulid.mint(now);
    if let Some(adsb) = &detection.adsb {
        if !stats.icaos.contains(&adsb.icao) {
            log(&format!(
                "aircraft acquired: {} ({} distinct this session)",
                adsb.icao,
                stats.icaos.len() + 1
            ));
            stats.icaos.insert(adsb.icao.clone());
        }
    }
    stats.parsed += 1;
    if !bus.publish(&detection) {
        stats.dropped += 1;
    }
}

/// Emit a heartbeat if one is due.
fn beat<B: Bus>(cfg: &Config, bus: &B, stats: &mut Stats, next: &mut Instant, healthy: bool) {
    let now = Instant::now();
    if now < *next {
        return;
    }
    *next = now + cfg.heartbeat_interval;
    // Health is the state of the link to dump1090, not the presence of
    // aircraft. An empty sky is a legitimate observation; a decoder we cannot
    // reach is not.
    bus.heartbeat(healthy, stats.detail(&cfg.address, bus.subscribers()));
}

/// Wait, without going deaf while waiting.
fn sleep_until<B: Bus>(
    total: Duration,
    cfg: &Config,
    bus: &B,
    stats: &mut Stats,
    next: &mut Instant,
    stop: &AtomicBool,
) {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        beat(cfg, bus, stats, next, false);
        std::thread::sleep(Duration::from_millis(50).min(total));
    }
}

fn connect(address: &str) -> std::io::Result<TcpStream> {
    // Resolution failure is reported like a refused connection rather than as a
    // separate class of problem: from the operator's side both mean "no
    // dump1090 at that address", and both recover the same way.
    let addr = address
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "resolved to no addresses"))?;
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    Ok(stream)
}

fn log(msg: &str) {
    eprintln!("{} adsb: {msg}", clock::now_rfc3339());
}

/// Read a stream that is not a socket. Only the tests need this; it exists so
/// the line splitting can be exercised without a TCP connection at all.
#[cfg(test)]
fn pump_reader<B: Bus, R: Read>(
    cfg: &Config,
    bus: &B,
    stats: &mut Stats,
    ulid: &mut UlidFactory,
    reader: R,
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        let chunk = match reader.fill_buf() {
            Ok([]) => break,
            Ok(buf) => buf.to_vec(),
            Err(_) => break,
        };
        reader.consume(chunk.len());
        for byte in chunk {
            match byte {
                b'\n' => {
                    handle_line(cfg, bus, stats, ulid, &line);
                    line.clear();
                }
                b'\r' => {}
                _ => line.push(byte),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection::Detection;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    // Fixtures lifted from a real dump1090 SBS-1 stream: one aircraft reported
    // across the three message types that carry data, plus the session records
    // that surround them.
    const POSITION: &str = "MSG,3,1,1,A1878A,1,2026/08/11,14:23:11.482,2026/08/11,14:23:11.482,,2100,,,47.1,8.2,,,,,,0";
    const IDENT: &str =
        "MSG,1,1,1,A1878A,1,2026/08/11,14:23:12.100,2026/08/11,14:23:12.100,REGA10  ,,,,,,,,,,,";
    const VELOCITY: &str =
        "MSG,4,1,1,4CA2D1,1,2026/08/11,14:23:13.000,2026/08/11,14:23:13.000,,,90,271,,,-64,,,,,";
    const SESSION: &str = "STA,,1,1,A1878A,1,2026/08/11,14:23:11.482,,,,,,,,,,,,,,";

    #[derive(Default)]
    struct Recorder {
        detections: Mutex<Vec<Detection>>,
        heartbeats: Mutex<Vec<(bool, serde_json::Value)>>,
        /// When set, `publish` refuses -- the bus-backpressure path.
        refuse: bool,
    }

    impl Bus for Recorder {
        fn publish(&self, detection: &Detection) -> bool {
            if self.refuse {
                return false;
            }
            self.detections.lock().unwrap().push(detection.clone());
            true
        }
        fn heartbeat(&self, healthy: bool, detail: serde_json::Value) {
            self.heartbeats.lock().unwrap().push((healthy, detail));
        }
        fn subscribers(&self) -> usize {
            1
        }
    }

    fn config(address: &str) -> Config {
        Config {
            sensor_id: "sdr-0".into(),
            address: address.into(),
            heartbeat_interval: Duration::from_millis(20),
            reconnect_max: Duration::from_millis(100),
        }
    }

    /// A dump1090 stand-in: writes the given lines, then behaves as told.
    enum Then {
        Close,
        /// Stay connected and silent, so the read path has to time out.
        Linger,
    }

    fn fake_dump1090(lines: Vec<String>, then: Then) -> (String, TcpListener) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = listener.try_clone().unwrap();
        thread::spawn(move || {
            for stream in accept.incoming() {
                let Ok(mut stream) = stream else { return };
                for line in &lines {
                    if stream.write_all(format!("{line}\r\n").as_bytes()).is_err() {
                        return;
                    }
                }
                let _ = stream.flush();
                match then {
                    Then::Close => drop(stream),
                    Then::Linger => loop {
                        thread::sleep(Duration::from_millis(50));
                        if stream.write_all(b"").is_err() {
                            return;
                        }
                    },
                }
            }
        });
        (addr, listener)
    }

    fn run_briefly(cfg: &Config, bus: &Recorder, until: impl Fn(&Recorder) -> bool) -> Stats {
        let stop = Arc::new(AtomicBool::new(false));
        let watcher = Arc::clone(&stop);
        let deadline = Instant::now() + Duration::from_secs(10);
        std::thread::scope(|scope| {
            let handle = scope.spawn(|| run(cfg, bus, &stop));
            while Instant::now() < deadline {
                if until(bus) {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            watcher.store(true, Ordering::Relaxed);
            handle.join().unwrap()
        })
    }

    #[test]
    fn parses_a_stream_into_detections() {
        let mut stats = Stats::default();
        let bus = Recorder::default();
        let cfg = config("unused");
        let stream = format!("{POSITION}\r\n{SESSION}\r\n{IDENT}\r\n{VELOCITY}\r\n");
        pump_reader(
            &cfg,
            &bus,
            &mut stats,
            &mut UlidFactory::seeded(1),
            stream.as_bytes(),
        );

        assert_eq!(stats.lines_read, 4);
        assert_eq!(stats.parsed, 3);
        assert_eq!(stats.unparsed, 1, "the STA record is not an observation");
        assert_eq!(stats.icaos.len(), 2);
        let detections = bus.detections.lock().unwrap();
        assert_eq!(detections.len(), 3);
        assert!(detections.iter().all(|d| d.detection_class == "D"));
        assert!(detections.iter().all(|d| d.sensor_id == "sdr-0"));
    }

    /// The caller owns ULID minting -- `sbs::parse_line` deliberately leaves the
    /// field empty -- so an empty `detection_id` here would fail schema
    /// validation at fusion rather than in this crate.
    #[test]
    fn every_detection_gets_a_unique_sortable_id() {
        let mut stats = Stats::default();
        let bus = Recorder::default();
        let cfg = config("unused");
        // Trailing terminator on purpose: a line with no newline yet is a
        // partial read, and the loop is right not to emit it.
        let stream = format!("{}\r\n", [POSITION; 200].join("\r\n"));
        pump_reader(
            &cfg,
            &bus,
            &mut stats,
            &mut UlidFactory::seeded(5),
            stream.as_bytes(),
        );

        let detections = bus.detections.lock().unwrap();
        assert_eq!(detections.len(), 200);
        let ids: std::collections::HashSet<&str> =
            detections.iter().map(|d| d.detection_id.as_str()).collect();
        assert_eq!(ids.len(), 200, "detection IDs must be unique");
        assert!(detections.iter().all(|d| d.detection_id.len() == 26));
    }

    /// A record with no terminator yet is a partial read, not an observation.
    /// Emitting it would hand fusion a truncated aircraft every time a TCP
    /// segment landed on a field boundary.
    #[test]
    fn an_unterminated_final_line_is_not_emitted() {
        let mut stats = Stats::default();
        let bus = Recorder::default();
        let cfg = config("unused");
        let stream = format!("{POSITION}\n{}", &POSITION[..40]);
        pump_reader(
            &cfg,
            &bus,
            &mut stats,
            &mut UlidFactory::seeded(8),
            stream.as_bytes(),
        );
        assert_eq!(stats.lines_read, 1);
        assert_eq!(bus.detections.lock().unwrap().len(), 1);
    }

    /// A partial read must not corrupt or drop the record that straddles it.
    #[test]
    fn a_line_split_across_reads_survives() {
        struct Trickle {
            data: Vec<u8>,
            at: usize,
        }
        impl Read for Trickle {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.at >= self.data.len() {
                    return Ok(0);
                }
                buf[0] = self.data[self.at];
                self.at += 1;
                Ok(1)
            }
        }

        let mut stats = Stats::default();
        let bus = Recorder::default();
        let cfg = config("unused");
        pump_reader(
            &cfg,
            &bus,
            &mut stats,
            &mut UlidFactory::seeded(2),
            Trickle {
                data: format!("{POSITION}\r\n{IDENT}\r\n").into_bytes(),
                at: 0,
            },
        );
        assert_eq!(stats.parsed, 2);
        assert!(bus.detections.lock().unwrap()[0].position.is_some());
    }

    /// Arbitrary bytes on port 30003 must not end the sensor. dump1090 is a
    /// separate process whose output this sensor does not control.
    #[test]
    fn garbage_on_the_socket_is_counted_not_fatal() {
        let mut stats = Stats::default();
        let bus = Recorder::default();
        let cfg = config("unused");
        let mut junk: Vec<u8> = Vec::new();
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..2_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            junk.push((seed & 0xFF) as u8);
        }
        junk.extend_from_slice(b"\n");
        junk.extend_from_slice(POSITION.as_bytes());
        junk.push(b'\n');
        pump_reader(
            &cfg,
            &bus,
            &mut stats,
            &mut UlidFactory::seeded(3),
            junk.as_slice(),
        );
        // The good record after the garbage still lands, which is the property
        // that matters: one bad line must not poison the stream.
        assert!(stats.parsed >= 1, "{stats:?}");
    }

    #[test]
    fn bus_backpressure_is_counted_rather_than_retried() {
        let mut stats = Stats::default();
        let bus = Recorder {
            refuse: true,
            ..Default::default()
        };
        let cfg = config("unused");
        let stream = format!("{}\n", [POSITION; 10].join("\n"));
        pump_reader(
            &cfg,
            &bus,
            &mut stats,
            &mut UlidFactory::seeded(4),
            stream.as_bytes(),
        );
        assert_eq!(stats.parsed, 10);
        assert_eq!(stats.dropped, 10);
    }

    // --- the loop against a socket ---------------------------------------

    #[test]
    fn reads_from_a_real_socket_and_reports_healthy() {
        let (addr, _listener) = fake_dump1090(
            vec![POSITION.into(), IDENT.into(), VELOCITY.into()],
            Then::Linger,
        );
        let bus = Recorder::default();
        let cfg = config(&addr);
        let stats = run_briefly(&cfg, &bus, |b| b.detections.lock().unwrap().len() >= 3);

        assert_eq!(stats.parsed, 3, "{stats:?}");
        assert_eq!(stats.icaos.len(), 2);
        let heartbeats = bus.heartbeats.lock().unwrap();
        assert!(!heartbeats.is_empty());
        assert!(
            heartbeats.iter().any(|(healthy, _)| *healthy),
            "a connected sensor must report healthy"
        );
    }

    /// dump1090 not running is an expected state, not a crash. The sensor must
    /// keep heartbeating -- unhealthy -- for as long as it is down.
    #[test]
    fn a_dead_dump1090_degrades_and_keeps_heartbeating() {
        // A port nothing is listening on: bind it to learn a free one, then let
        // it go.
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = probe.local_addr().unwrap().to_string();
        drop(probe);

        let bus = Recorder::default();
        let cfg = config(&addr);
        let stats = run_briefly(&cfg, &bus, |b| b.heartbeats.lock().unwrap().len() >= 3);

        assert_eq!(stats.parsed, 0);
        assert!(bus.detections.lock().unwrap().is_empty());
        let heartbeats = bus.heartbeats.lock().unwrap();
        assert!(heartbeats.len() >= 3, "{} heartbeats", heartbeats.len());
        assert!(
            heartbeats.iter().all(|(healthy, _)| !*healthy),
            "an unreachable dump1090 must report unhealthy"
        );
        let (_, detail) = heartbeats.last().unwrap();
        assert_eq!(detail["connected"], false);
        assert!(detail["error"].is_string(), "{detail}");
        assert!(detail["seconds_since_message"].is_null());
    }

    /// dump1090 dying mid-stream reconnects rather than exiting, and says so in
    /// the counter that distinguishes it from a quiet sky.
    #[test]
    fn a_stream_that_ends_is_reconnected() {
        let (addr, _listener) = fake_dump1090(vec![POSITION.into()], Then::Close);
        let bus = Recorder::default();
        let cfg = config(&addr);
        let stats = run_briefly(&cfg, &bus, |b| b.detections.lock().unwrap().len() >= 3);

        assert!(stats.reconnects >= 2, "{stats:?}");
        assert!(stats.parsed >= 3, "{stats:?}");
        let heartbeats = bus.heartbeats.lock().unwrap();
        let (_, detail) = heartbeats.last().unwrap();
        assert!(detail["reconnects"].as_u64().unwrap() >= 1, "{detail}");
    }

    /// An empty sky is healthy. This is the case that would be easiest to get
    /// wrong, and getting it wrong means a working sensor reports as broken
    /// every time nothing is flying.
    #[test]
    fn a_silent_but_connected_stream_stays_healthy() {
        let (addr, _listener) = fake_dump1090(Vec::new(), Then::Linger);
        let bus = Recorder::default();
        let cfg = config(&addr);
        run_briefly(&cfg, &bus, |b| b.heartbeats.lock().unwrap().len() >= 4);

        let heartbeats = bus.heartbeats.lock().unwrap();
        let connected: Vec<_> = heartbeats
            .iter()
            .filter(|(_, d)| d["connected"] == true)
            .collect();
        assert!(!connected.is_empty(), "never connected: {heartbeats:?}");
        assert!(
            connected.iter().all(|(healthy, _)| *healthy),
            "no aircraft is not a fault"
        );
        assert_eq!(connected.last().unwrap().1["messages_read"], 0);
    }

    #[test]
    fn the_heartbeat_carries_the_counters_an_operator_needs() {
        let (addr, _listener) = fake_dump1090(vec![POSITION.into(), IDENT.into()], Then::Linger);
        let bus = Recorder::default();
        let cfg = config(&addr);
        run_briefly(&cfg, &bus, |b| b.detections.lock().unwrap().len() >= 2);

        let heartbeats = bus.heartbeats.lock().unwrap();
        let (_, detail) = heartbeats
            .iter()
            .rev()
            .find(|(_, d)| d["messages_read"].as_u64().unwrap_or(0) >= 2)
            .expect("a heartbeat after both messages");
        assert_eq!(detail["source"], addr);
        assert_eq!(detail["parsed"], 2);
        assert_eq!(detail["icaos"], 1);
        assert!(detail["seconds_since_message"].as_f64().is_some());
        assert_eq!(detail["subscribers"], 1);
    }

    /// A peer that opens the socket and never sends a newline must not grow the
    /// buffer without limit.
    #[test]
    fn a_line_that_never_ends_is_discarded_not_buffered() {
        let mut stats = Stats::default();
        let bus = Recorder::default();
        let cfg = config("unused");
        let stop = AtomicBool::new(false);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let blob = vec![b'x'; 8 * 1024];
            for _ in 0..32 {
                if stream.write_all(&blob).is_err() {
                    return;
                }
            }
            let _ = stream.write_all(format!("\n{POSITION}\n").as_bytes());
            thread::sleep(Duration::from_secs(2));
        });

        let stream = TcpStream::connect(addr).unwrap();
        stream.set_read_timeout(Some(READ_TIMEOUT)).unwrap();
        let mut next = Instant::now();
        thread::scope(|scope| {
            let handle = scope.spawn(|| {
                let mut ulid = UlidFactory::seeded(6);
                pump(&cfg, &bus, &mut stats, &mut ulid, &mut next, stream, &stop);
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && bus.detections.lock().unwrap().is_empty() {
                thread::sleep(Duration::from_millis(20));
            }
            stop.store(true, Ordering::Relaxed);
            handle.join().unwrap();
        });

        assert_eq!(
            bus.detections.lock().unwrap().len(),
            1,
            "the record after the oversized blob must still be read"
        );
    }
}

//! A PUB socket speaking ZMTP 3.0 over TCP, implemented on `std::net`.
//!
//! # Why this is hand-written
//!
//! The obvious move is a crate. The two candidates both fail a hard constraint:
//!
//! - **`zmq` (libzmq bindings)** links a C library. The CI `rust` job installs
//!   no system packages, so it does not build there at all.
//! - **`zeromq` 0.6 (zmq.rs, pure Rust)** builds -- it was tried -- but pulls in
//!   84 transitive crates and a Tokio runtime into a sensor that otherwise has
//!   three dependencies, and every one of those crates is in scope for the CI
//!   `cargo audit` step. More decisively, its `PubSocket::send` *awaits* each
//!   subscriber's send queue and offers no high-water mark and no NOBLOCK. That
//!   is the exact behaviour ADR-0002 forbids: "a capture loop must never block
//!   on the bus". Using it correctly would mean putting a bounded, dropping
//!   queue in front of it -- which is the whole of what this module is.
//!
//! What is left is small. The PUB half of ZMTP 3.0 is a 64-byte greeting, one
//! READY command, a length-prefixed frame writer, and a prefix match against
//! whatever the subscriber asked for.
//!
//! # Who the peer actually is
//!
//! `fusion` subscribes with [`go-zeromq/zmq4`](https://github.com/go-zeromq/zmq4)
//! v0.17.0, and this implementation was written against its wire behaviour:
//!
//! - It announces version 3.0 and accepts anything at or above that, so this
//!   sends 3.0 -- which also keeps subscriptions in their ZMTP 3.0 form
//!   (a one-frame message prefixed `0x01`) rather than the 3.1 SUBSCRIBE
//!   command that a peer negotiating 3.1 would send.
//! - **It does not filter on receive.** `subSocket.Recv` returns whatever
//!   arrives; the filtering lives in `pubMWriter.sendMsg` on the publisher
//!   side. So honouring subscriptions here is not an optimisation, it is the
//!   only thing standing between a `detection.D`-only consumer and every
//!   message on the bus.
//!
//! # Backpressure
//!
//! [`Outbox`] is a bounded queue with a non-blocking send. When it is full the
//! message is dropped and counted, exactly like `zmq.NOBLOCK` against `SNDHWM`
//! in `classg_wifi/bus.py`. Writing to peers happens on a separate thread, so a
//! wedged subscriber can never stall the ingest loop.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const GREETING_LEN: usize = 64;
const SIG_HEADER: u8 = 0xFF;
const SIG_FOOTER: u8 = 0x7F;
const VERSION_MAJOR: u8 = 3;
const VERSION_MINOR: u8 = 0;
const MECHANISM: &[u8] = b"NULL";

const FLAG_MORE: u8 = 0x01;
const FLAG_LONG: u8 = 0x02;
const FLAG_COMMAND: u8 = 0x04;

/// A frame larger than this is a protocol desync or a hostile peer, not a
/// subscription. Refusing it stops a bogus 8-byte length from turning into an
/// allocation that ends the process.
const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;

/// A peer that cannot absorb this much silence has stopped reading. Dropping it
/// is PUB semantics; the alternative is stalling every other subscriber.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
/// A TCP connection that opens and then says nothing is not a subscriber.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// One bus message: topic frame then body frame, matching the `send_multipart`
/// in `classg_wifi/bus.py`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub topic: Vec<u8>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketMode {
    Bind,
    Connect,
}

impl SocketMode {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "bind" => Ok(SocketMode::Bind),
            "connect" => Ok(SocketMode::Connect),
            other => Err(format!("{other:?} is not 'bind' or 'connect'")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SocketMode::Bind => "bind",
            SocketMode::Connect => "connect",
        }
    }
}

/// The bounded, dropping queue in front of the wire.
///
/// Split out from [`PubSocket`] so the drop accounting can be tested directly
/// against a receiver nobody drains -- the case that matters and the one that is
/// impossible to provoke reliably through a real TCP peer, whose kernel buffers
/// absorb far more than any test wants to write.
pub struct Outbox {
    tx: SyncSender<Message>,
    published: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
}

impl Outbox {
    pub fn new(hwm: usize) -> (Self, Receiver<Message>) {
        // sync_channel(0) is a rendezvous channel: send blocks until a receiver
        // is ready. That is precisely the behaviour ADR-0002 rules out, so a
        // zero HWM becomes one slot rather than a subtle stall.
        let (tx, rx) = sync_channel(hwm.max(1));
        (
            Self {
                tx,
                published: Arc::new(AtomicU64::new(0)),
                dropped: Arc::new(AtomicU64::new(0)),
            },
            rx,
        )
    }

    /// Queue a message, or drop it. Never blocks, never fails loudly.
    pub fn send(&self, msg: Message) -> bool {
        match self.tx.try_send(msg) {
            Ok(()) => {
                self.published.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    pub fn published(&self) -> u64 {
        self.published.load(Ordering::Relaxed)
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// A connected subscriber.
struct Peer {
    label: String,
    out: Mutex<TcpStream>,
    subscriptions: Mutex<Vec<Vec<u8>>>,
    alive: AtomicBool,
}

impl Peer {
    fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    fn kill(&self) {
        if self.alive.swap(false, Ordering::Relaxed) {
            if let Ok(stream) = self.out.lock() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }

    /// ZMQ prefix matching: an empty subscription matches everything, which is
    /// what a consumer that subscribed to `""` expects.
    fn subscribed(&self, topic: &[u8]) -> bool {
        let subs = match self.subscriptions.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        subs.iter().any(|s| topic.starts_with(s))
    }

    fn deliver(&self, msg: &Message) {
        // One buffer, one write: a frame interleaved with another thread's
        // frame is an unrecoverable desync, and there is no resync in ZMTP.
        let mut buf = Vec::with_capacity(msg.topic.len() + msg.body.len() + 20);
        encode_frame(&mut buf, &msg.topic, FLAG_MORE);
        encode_frame(&mut buf, &msg.body, 0);

        let mut stream = match self.out.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Err(err) = stream.write_all(&buf) {
            // A write timeout means a partial frame is already on the wire, so
            // this connection cannot be reused whatever the cause was.
            drop(stream);
            log(&format!(
                "subscriber {} dropped: {err}",
                self.label.as_str()
            ));
            self.kill();
        }
    }
}

/// A ZMTP PUB socket.
pub struct PubSocket {
    outbox: Outbox,
    peers: Arc<Mutex<Vec<Arc<Peer>>>>,
}

impl PubSocket {
    /// Open the socket.
    ///
    /// In `Connect` mode this returns as soon as the endpoint parses: the dialer
    /// retries in the background forever, so fusion starting after the sensor is
    /// a normal state rather than a startup failure. In `Bind` mode a failure to
    /// take the port is returned, because there is nothing to degrade *to* --
    /// nobody can reach a socket that does not exist, heartbeats included.
    pub fn open(
        endpoint: &str,
        mode: SocketMode,
        hwm: usize,
        reconnect_max: Duration,
    ) -> io::Result<Self> {
        let addr = parse_endpoint(endpoint)?;
        let (outbox, rx) = Outbox::new(hwm);
        let peers: Arc<Mutex<Vec<Arc<Peer>>>> = Arc::new(Mutex::new(Vec::new()));

        match mode {
            SocketMode::Bind => {
                let listener = TcpListener::bind(&addr[..])?;
                let peers = Arc::clone(&peers);
                thread::Builder::new()
                    .name("zmtp-accept".into())
                    .spawn(move || accept_loop(listener, peers))?;
            }
            SocketMode::Connect => {
                let peers = Arc::clone(&peers);
                let endpoint = endpoint.to_string();
                thread::Builder::new()
                    .name("zmtp-dial".into())
                    .spawn(move || dial_loop(&endpoint, addr, peers, reconnect_max))?;
            }
        }

        let hub_peers = Arc::clone(&peers);
        thread::Builder::new()
            .name("zmtp-hub".into())
            .spawn(move || hub_loop(rx, hub_peers))?;

        Ok(Self { outbox, peers })
    }

    pub fn send(&self, topic: &[u8], body: &[u8]) -> bool {
        self.outbox.send(Message {
            topic: topic.to_vec(),
            body: body.to_vec(),
        })
    }

    pub fn published(&self) -> u64 {
        self.outbox.published()
    }

    pub fn dropped(&self) -> u64 {
        self.outbox.dropped()
    }

    /// Live subscribers. Zero is not an error -- PUB/SUB drops with nobody
    /// listening by design (ADR-0002) -- but it belongs in the heartbeat, because
    /// "publishing into the void" and "publishing to fusion" look identical from
    /// in here otherwise.
    pub fn peers(&self) -> usize {
        let mut peers = match self.peers.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        peers.retain(|p| p.alive());
        peers.len()
    }
}

fn hub_loop(rx: Receiver<Message>, peers: Arc<Mutex<Vec<Arc<Peer>>>>) {
    while let Ok(msg) = rx.recv() {
        let targets: Vec<Arc<Peer>> = {
            let mut peers = match peers.lock() {
                Ok(p) => p,
                Err(poisoned) => poisoned.into_inner(),
            };
            peers.retain(|p| p.alive());
            peers.iter().cloned().collect()
        };
        // Deliver outside the registry lock so a slow socket cannot block the
        // dialer or the acceptor from registering a new subscriber.
        for peer in targets {
            if peer.subscribed(&msg.topic) {
                peer.deliver(&msg);
            }
        }
    }
}

fn accept_loop(listener: TcpListener, peers: Arc<Mutex<Vec<Arc<Peer>>>>) {
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(err) => {
                log(&format!("accept failed: {err}"));
                thread::sleep(Duration::from_millis(200));
                continue;
            }
        };
        let peers = Arc::clone(&peers);
        // Handshake off the accept path: a peer that connects and then says
        // nothing must not stop the next subscriber from being accepted.
        let spawned = thread::Builder::new()
            .name("zmtp-handshake".into())
            .spawn(move || {
                let label = stream
                    .peer_addr()
                    .map(|a| a.to_string())
                    .unwrap_or_else(|_| "unknown".into());
                match register(stream, label.clone(), &peers) {
                    Ok(()) => log(&format!("subscriber {label} connected")),
                    Err(err) => log(&format!("subscriber {label} rejected: {err}")),
                }
            });
        if let Err(err) = spawned {
            log(&format!("could not spawn handshake thread: {err}"));
        }
    }
}

fn dial_loop(
    endpoint: &str,
    addrs: Vec<SocketAddr>,
    peers: Arc<Mutex<Vec<Arc<Peer>>>>,
    reconnect_max: Duration,
) {
    let min = Duration::from_millis(250);
    let mut backoff = min;
    let mut complained = false;
    loop {
        let connected = {
            let mut peers = match peers.lock() {
                Ok(p) => p,
                Err(poisoned) => poisoned.into_inner(),
            };
            peers.retain(|p| p.alive());
            !peers.is_empty()
        };
        if connected {
            thread::sleep(min);
            continue;
        }

        match TcpStream::connect_timeout(&addrs[0], Duration::from_secs(5))
            .and_then(|s| register(s, endpoint.to_string(), &peers))
        {
            Ok(()) => {
                log(&format!("connected to the detection bus at {endpoint}"));
                backoff = min;
                complained = false;
            }
            Err(err) => {
                // Once per outage, not once per attempt: fusion starting after
                // the sensor is routine and must not fill the journal.
                if !complained {
                    log(&format!("detection bus {endpoint} unavailable: {err}"));
                    complained = true;
                }
                thread::sleep(backoff);
                backoff = (backoff * 2).min(reconnect_max.max(min));
            }
        }
    }
}

/// Perform the ZMTP handshake and add the result to the peer registry.
fn register(
    mut stream: TcpStream,
    label: String,
    peers: &Arc<Mutex<Vec<Arc<Peer>>>>,
) -> io::Result<()> {
    let _ = stream.set_nodelay(true);
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    handshake(&mut stream)?;

    let reader = stream.try_clone()?;
    // Blocking reads from here on: the subscription reader has its own thread
    // and waking it up on a timer buys nothing.
    reader.set_read_timeout(None)?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;

    let peer = Arc::new(Peer {
        label,
        out: Mutex::new(stream),
        subscriptions: Mutex::new(Vec::new()),
        alive: AtomicBool::new(true),
    });
    {
        let mut peers = match peers.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        peers.retain(|p| p.alive());
        peers.push(Arc::clone(&peer));
    }

    thread::Builder::new()
        .name("zmtp-peer".into())
        .spawn(move || subscription_loop(reader, peer))?;
    Ok(())
}

/// Read subscriptions from a subscriber for as long as it lives.
fn subscription_loop(mut reader: TcpStream, peer: Arc<Peer>) {
    // A read error or EOF is the subscriber going away, which is routine.
    while let Ok(frames) = read_message(&mut reader) {
        // A SUB peer sends exactly two things: subscription updates (a single
        // message frame whose first byte is 1 to subscribe or 0 to cancel) and,
        // if it has heartbeating on, PING commands. Anything else is not
        // meaningful to a publisher and is ignored rather than fatal.
        match frames.as_slice() {
            [Frame {
                command: true,
                body,
            }] if body.starts_with(b"\x04PING") => {
                let mut pong = Vec::new();
                encode_command(&mut pong, b"PONG", &[]);
                let mut out = match peer.out.lock() {
                    Ok(s) => s,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if out.write_all(&pong).is_err() {
                    drop(out);
                    break;
                }
            }
            [Frame {
                command: false,
                body,
            }] if matches!(body.first(), Some(0) | Some(1)) => {
                let topic = body[1..].to_vec();
                let mut subs = match peer.subscriptions.lock() {
                    Ok(s) => s,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if body[0] == 1 {
                    if !subs.contains(&topic) {
                        subs.push(topic);
                    }
                } else {
                    subs.retain(|s| s != &topic);
                }
            }
            _ => {}
        }
    }
    log(&format!("subscriber {} disconnected", peer.label));
    peer.kill();
}

// --- wire format -----------------------------------------------------------

#[derive(Debug)]
struct Frame {
    command: bool,
    body: Vec<u8>,
}

fn greeting() -> [u8; GREETING_LEN] {
    let mut g = [0u8; GREETING_LEN];
    g[0] = SIG_HEADER;
    g[9] = SIG_FOOTER;
    g[10] = VERSION_MAJOR;
    g[11] = VERSION_MINOR;
    g[12..12 + MECHANISM.len()].copy_from_slice(MECHANISM);
    // g[32] (as-server) stays 0: NULL defines no client/server topology, and
    // zmq4 sends 0 here unconditionally.
    g
}

fn validate_greeting(g: &[u8; GREETING_LEN]) -> io::Result<()> {
    if g[0] != SIG_HEADER || g[9] != SIG_FOOTER {
        return Err(protocol("not a ZMTP greeting"));
    }
    if g[10] < VERSION_MAJOR {
        return Err(protocol(&format!(
            "peer speaks ZMTP {}.{}, which predates 3.0",
            g[10], g[11]
        )));
    }
    let mechanism: Vec<u8> = g[12..32].iter().copied().take_while(|b| *b != 0).collect();
    if mechanism != MECHANISM {
        return Err(protocol(&format!(
            "peer wants the {} security mechanism, not NULL",
            String::from_utf8_lossy(&mechanism)
        )));
    }
    Ok(())
}

fn encode_frame(out: &mut Vec<u8>, body: &[u8], extra_flags: u8) {
    let long = body.len() > 255;
    let flags = extra_flags | if long { FLAG_LONG } else { 0 };
    out.push(flags);
    if long {
        out.extend_from_slice(&(body.len() as u64).to_be_bytes());
    } else {
        out.push(body.len() as u8);
    }
    out.extend_from_slice(body);
}

fn encode_command(out: &mut Vec<u8>, name: &[u8], properties: &[u8]) {
    let mut body = Vec::with_capacity(1 + name.len() + properties.len());
    body.push(name.len() as u8);
    body.extend_from_slice(name);
    body.extend_from_slice(properties);
    encode_frame(out, &body, FLAG_COMMAND);
}

fn encode_property(out: &mut Vec<u8>, key: &str, value: &str) {
    out.push(key.len() as u8);
    out.extend_from_slice(key.as_bytes());
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value.as_bytes());
}

fn ready_command() -> Vec<u8> {
    let mut properties = Vec::new();
    encode_property(&mut properties, "Socket-Type", "PUB");
    // Identity is what zmq4 also sends; an empty one is correct for PUB and
    // omitting the key entirely is legal but makes the peer's metadata map
    // differ from what libzmq produces for no benefit.
    encode_property(&mut properties, "Identity", "");
    let mut out = Vec::new();
    encode_command(&mut out, b"READY", &properties);
    out
}

fn read_frame(r: &mut impl Read) -> io::Result<Frame> {
    let mut header = [0u8; 2];
    r.read_exact(&mut header)?;
    read_frame_body(r, header)
}

fn read_message(r: &mut impl Read) -> io::Result<Vec<Frame>> {
    let mut frames = Vec::new();
    loop {
        let mut header = [0u8; 2];
        r.read_exact(&mut header)?;
        let more = header[0] & FLAG_MORE != 0;
        frames.push(read_frame_body(r, header)?);
        if !more {
            return Ok(frames);
        }
        if frames.len() > 64 {
            return Err(protocol("more frames than any bus message has"));
        }
    }
}

/// The header is already read, because a multipart reader has to inspect the
/// MORE bit before it knows whether to loop.
fn read_frame_body(r: &mut impl Read, header: [u8; 2]) -> io::Result<Frame> {
    let flags = header[0];
    let size = if flags & FLAG_LONG != 0 {
        let mut long = [0u8; 8];
        long[0] = header[1];
        r.read_exact(&mut long[1..])?;
        u64::from_be_bytes(long)
    } else {
        u64::from(header[1])
    };
    if size > MAX_FRAME_BYTES {
        return Err(protocol(&format!("{size}-byte frame is implausible")));
    }
    let mut body = vec![0u8; size as usize];
    r.read_exact(&mut body)?;
    Ok(Frame {
        command: flags & FLAG_COMMAND != 0,
        body,
    })
}

fn handshake(stream: &mut TcpStream) -> io::Result<()> {
    stream.write_all(&greeting())?;
    stream.flush()?;

    let mut theirs = [0u8; GREETING_LEN];
    stream.read_exact(&mut theirs)?;
    validate_greeting(&theirs)?;

    stream.write_all(&ready_command())?;
    stream.flush()?;

    let frame = read_frame(stream)?;
    if !frame.command {
        return Err(protocol("expected a READY command, got a message"));
    }
    let (name, properties) = split_command(&frame.body)?;
    if name != b"READY" {
        return Err(protocol(&format!(
            "expected READY, got {}",
            String::from_utf8_lossy(name)
        )));
    }
    match property(properties, "socket-type").as_deref() {
        // XSUB is what a forwarder device presents; it is a legal PUB peer and
        // costs nothing to accept.
        Some("SUB") | Some("XSUB") => Ok(()),
        Some(other) => Err(protocol(&format!(
            "peer is a {other} socket, which cannot subscribe to a PUB"
        ))),
        None => Err(protocol("peer's READY declared no Socket-Type")),
    }
}

fn split_command(body: &[u8]) -> io::Result<(&[u8], &[u8])> {
    let len = *body.first().ok_or_else(|| protocol("empty command"))? as usize;
    if body.len() < 1 + len {
        return Err(protocol("command name runs past the end of the frame"));
    }
    Ok((&body[1..1 + len], &body[1 + len..]))
}

/// Look up a ZMTP metadata property. Names are case-insensitive per the spec,
/// and zmq4 title-cases them on both sides, so comparing lowercased is the only
/// form that works against every peer.
fn property(mut raw: &[u8], want_lowercase: &str) -> Option<String> {
    while !raw.is_empty() {
        let klen = raw[0] as usize;
        if raw.len() < 1 + klen + 4 {
            return None;
        }
        let key = &raw[1..1 + klen];
        let vlen = u32::from_be_bytes(raw[1 + klen..5 + klen].try_into().ok()?) as usize;
        if raw.len() < 5 + klen + vlen {
            return None;
        }
        let value = &raw[5 + klen..5 + klen + vlen];
        if String::from_utf8_lossy(key).to_ascii_lowercase() == want_lowercase {
            return Some(String::from_utf8_lossy(value).into_owned());
        }
        raw = &raw[5 + klen + vlen..];
    }
    None
}

fn protocol(msg: &str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, msg.to_string())
}

/// `tcp://host:port` -- the only transport ADR-0002 uses. `ipc://` is rejected
/// with the reason rather than silently treated as a hostname.
fn parse_endpoint(endpoint: &str) -> io::Result<Vec<SocketAddr>> {
    let Some(hostport) = endpoint.strip_prefix("tcp://") else {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            format!("{endpoint:?} is not a tcp:// endpoint; ADR-0002 puts the bus on TCP loopback"),
        ));
    };
    let addrs: Vec<SocketAddr> = hostport.to_socket_addrs()?.collect();
    if addrs.is_empty() {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            format!("{hostport:?} resolved to no addresses"),
        ));
    }
    Ok(addrs)
}

fn log(msg: &str) {
    eprintln!("{} bus: {msg}", crate::clock::now_rfc3339());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;
    use std::sync::mpsc::channel;

    #[test]
    fn greeting_is_the_zmtp_shape_zmq4_expects() {
        let g = greeting();
        assert_eq!(g.len(), 64);
        assert_eq!(g[0], 0xFF);
        assert_eq!(g[1..9], [0; 8]);
        assert_eq!(g[9], 0x7F);
        assert_eq!([g[10], g[11]], [3, 0]);
        assert_eq!(&g[12..16], b"NULL");
        assert_eq!(g[16..32], [0; 16], "mechanism must be zero-padded to 20");
        assert_eq!(g[32], 0, "as-server is 0 under NULL");
        assert_eq!(g[33..64], [0; 31]);
        assert!(validate_greeting(&g).is_ok());
    }

    #[test]
    fn rejects_a_greeting_that_is_not_zmtp() {
        let mut g = greeting();
        g[0] = 0x00;
        assert!(validate_greeting(&g).is_err());

        let mut older = greeting();
        older[10] = 2;
        assert!(validate_greeting(&older).is_err());

        let mut curve = greeting();
        curve[12..17].copy_from_slice(b"CURVE");
        let err = validate_greeting(&curve).unwrap_err();
        assert!(err.to_string().contains("CURVE"), "{err}");
    }

    /// A peer announcing 3.1 or later must be accepted: zmq4's own greeting
    /// validator accepts higher versions, and refusing them would make a
    /// toolchain upgrade on the fusion side look like a dead sensor.
    #[test]
    fn accepts_a_newer_peer_version() {
        let mut newer = greeting();
        newer[11] = 1;
        assert!(validate_greeting(&newer).is_ok());
    }

    #[test]
    fn ready_advertises_a_pub_socket() {
        let cmd = ready_command();
        assert_eq!(cmd[0] & FLAG_COMMAND, FLAG_COMMAND);
        assert_eq!(cmd[0] & FLAG_LONG, 0, "READY is short enough for one byte");
        let body = &cmd[2..];
        let (name, properties) = split_command(body).unwrap();
        assert_eq!(name, b"READY");
        assert_eq!(property(properties, "socket-type").as_deref(), Some("PUB"));
    }

    #[test]
    fn frames_over_255_bytes_use_the_long_encoding() {
        let mut short = Vec::new();
        encode_frame(&mut short, &[0u8; 255], 0);
        assert_eq!(short[0] & FLAG_LONG, 0);
        assert_eq!(short[1], 255);
        assert_eq!(short.len(), 257);

        let mut long = Vec::new();
        encode_frame(&mut long, &[0u8; 256], 0);
        assert_eq!(long[0] & FLAG_LONG, FLAG_LONG);
        assert_eq!(u64::from_be_bytes(long[1..9].try_into().unwrap()), 256);
        assert_eq!(long.len(), 265);
    }

    /// A detection is comfortably over 255 bytes, so the long path is the one
    /// that actually carries traffic; round-trip it through the reader.
    #[test]
    fn a_long_frame_round_trips() {
        let payload = vec![b'x'; 4096];
        let mut buf = Vec::new();
        encode_frame(&mut buf, b"detection.D", FLAG_MORE);
        encode_frame(&mut buf, &payload, 0);
        let frames = read_message(&mut buf.as_slice()).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].body, b"detection.D");
        assert_eq!(frames[1].body, payload);
    }

    #[test]
    fn an_implausible_frame_length_is_refused_not_allocated() {
        // Long flag with a 2^60 length: a naive reader allocates a exabyte.
        let mut buf = vec![FLAG_LONG];
        buf.extend_from_slice(&(1u64 << 60).to_be_bytes());
        let err = read_message(&mut buf.as_slice()).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn endpoint_parsing_names_the_problem() {
        assert!(parse_endpoint("tcp://127.0.0.1:5556").is_ok());
        let err = parse_endpoint("ipc:///tmp/classg").unwrap_err();
        assert!(err.to_string().contains("tcp://"), "{err}");
        let err = parse_endpoint("127.0.0.1:5556").unwrap_err();
        assert!(err.to_string().contains("tcp://"), "{err}");
    }

    #[test]
    fn socket_mode_parses_the_two_documented_values() {
        assert_eq!(SocketMode::parse("bind"), Ok(SocketMode::Bind));
        assert_eq!(SocketMode::parse("connect"), Ok(SocketMode::Connect));
        assert!(SocketMode::parse("dial").is_err());
    }

    /// The ADR-0002 property, tested where it can be tested deterministically:
    /// with the queue full, `send` returns immediately, reports the loss and
    /// counts it.
    #[test]
    fn a_full_outbox_drops_instead_of_blocking() {
        let (outbox, rx) = Outbox::new(4);
        for i in 0..4 {
            assert!(
                outbox.send(Message {
                    topic: b"detection.D".to_vec(),
                    body: vec![i],
                }),
                "slot {i} should have been free"
            );
        }
        for _ in 0..10 {
            assert!(!outbox.send(Message {
                topic: b"detection.D".to_vec(),
                body: vec![9],
            }));
        }
        assert_eq!(outbox.published(), 4);
        assert_eq!(outbox.dropped(), 10);
        // The four that fit are still there and still in order.
        for i in 0..4 {
            assert_eq!(rx.recv().unwrap().body, vec![i]);
        }
    }

    #[test]
    fn a_zero_high_water_mark_does_not_become_a_rendezvous_channel() {
        let (outbox, _rx) = Outbox::new(0);
        assert!(outbox.send(Message {
            topic: b"heartbeat.sdr".to_vec(),
            body: b"{}".to_vec(),
        }));
    }

    // --- a fake SUB peer, byte-for-byte as go-zeromq/zmq4 behaves ----------

    struct FakeSub {
        stream: TcpStream,
    }

    impl FakeSub {
        /// Complete the SUB half of the handshake.
        fn handshake(mut stream: TcpStream) -> io::Result<Self> {
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            stream.write_all(&greeting())?;
            let mut theirs = [0u8; GREETING_LEN];
            stream.read_exact(&mut theirs)?;
            validate_greeting(&theirs).expect("publisher sent a valid greeting");

            let mut properties = Vec::new();
            encode_property(&mut properties, "Socket-Type", "SUB");
            encode_property(&mut properties, "Identity", "");
            let mut ready = Vec::new();
            encode_command(&mut ready, b"READY", &properties);
            stream.write_all(&ready)?;

            let frame = read_frame(&mut stream)?;
            assert!(frame.command);
            let (name, props) = split_command(&frame.body).unwrap();
            assert_eq!(name, b"READY");
            assert_eq!(property(props, "socket-type").as_deref(), Some("PUB"));
            Ok(Self { stream })
        }

        /// zmq4 sends subscriptions as a one-frame message prefixed with 0x01.
        fn subscribe(&mut self, topic: &str) -> io::Result<()> {
            let mut body = vec![1u8];
            body.extend_from_slice(topic.as_bytes());
            let mut buf = Vec::new();
            encode_frame(&mut buf, &body, 0);
            self.stream.write_all(&buf)
        }

        fn unsubscribe(&mut self, topic: &str) -> io::Result<()> {
            let mut body = vec![0u8];
            body.extend_from_slice(topic.as_bytes());
            let mut buf = Vec::new();
            encode_frame(&mut buf, &body, 0);
            self.stream.write_all(&buf)
        }

        fn recv(&mut self) -> io::Result<(String, String)> {
            let frames = read_message(&mut self.stream)?;
            assert_eq!(frames.len(), 2, "bus messages are topic + body");
            Ok((
                String::from_utf8_lossy(&frames[0].body).into_owned(),
                String::from_utf8_lossy(&frames[1].body).into_owned(),
            ))
        }
    }

    fn publisher_bound_to_a_free_port() -> (PubSocket, String) {
        // Ask the OS for a port, then release it: binding :0 inside PubSocket
        // would leave no way to learn which port it took.
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let endpoint = format!("tcp://127.0.0.1:{port}");
        let sock =
            PubSocket::open(&endpoint, SocketMode::Bind, 16, Duration::from_millis(50)).unwrap();
        (sock, endpoint)
    }

    fn wait_for_peer(sock: &PubSocket) {
        for _ in 0..200 {
            if sock.peers() > 0 {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("no subscriber registered within 2s");
    }

    #[test]
    fn delivers_a_subscribed_message_end_to_end() {
        let (sock, endpoint) = publisher_bound_to_a_free_port();
        let addr = endpoint.trim_start_matches("tcp://").to_string();
        let mut sub = FakeSub::handshake(TcpStream::connect(&addr).unwrap()).unwrap();
        sub.subscribe("detection.").unwrap();
        wait_for_peer(&sock);
        // The subscription is read on its own thread; give it a moment to land
        // before the first publish, exactly as a real consumer must.
        thread::sleep(Duration::from_millis(100));

        assert!(sock.send(b"detection.D", br#"{"detection_class":"D"}"#));
        let (topic, body) = sub.recv().unwrap();
        assert_eq!(topic, "detection.D");
        assert_eq!(body, r#"{"detection_class":"D"}"#);
        assert_eq!(sock.published(), 1);
        assert_eq!(sock.dropped(), 0);
    }

    /// zmq4's SUB does not filter on receive -- `pubMWriter.sendMsg` does. So a
    /// consumer subscribed to `detection.D` must not see heartbeats, and the
    /// only code that can enforce that is here.
    #[test]
    fn honours_the_subscription_prefix() {
        let (sock, endpoint) = publisher_bound_to_a_free_port();
        let addr = endpoint.trim_start_matches("tcp://").to_string();
        let mut sub = FakeSub::handshake(TcpStream::connect(&addr).unwrap()).unwrap();
        sub.subscribe("detection.D").unwrap();
        wait_for_peer(&sock);
        thread::sleep(Duration::from_millis(100));

        sock.send(b"heartbeat.sdr", b"{}");
        sock.send(b"detection.E", b"{}");
        sock.send(b"detection.D", b"wanted");
        let (topic, body) = sub.recv().unwrap();
        assert_eq!(topic, "detection.D", "an unsubscribed topic got through");
        assert_eq!(body, "wanted");
    }

    #[test]
    fn an_empty_subscription_matches_everything() {
        let (sock, endpoint) = publisher_bound_to_a_free_port();
        let addr = endpoint.trim_start_matches("tcp://").to_string();
        let mut sub = FakeSub::handshake(TcpStream::connect(&addr).unwrap()).unwrap();
        sub.subscribe("").unwrap();
        wait_for_peer(&sock);
        thread::sleep(Duration::from_millis(100));

        sock.send(b"heartbeat.sdr", b"beat");
        assert_eq!(sub.recv().unwrap(), ("heartbeat.sdr".into(), "beat".into()));
    }

    #[test]
    fn a_cancelled_subscription_stops_delivery() {
        let (sock, endpoint) = publisher_bound_to_a_free_port();
        let addr = endpoint.trim_start_matches("tcp://").to_string();
        let mut sub = FakeSub::handshake(TcpStream::connect(&addr).unwrap()).unwrap();
        sub.subscribe("detection.").unwrap();
        sub.subscribe("heartbeat.").unwrap();
        wait_for_peer(&sock);
        thread::sleep(Duration::from_millis(100));
        sub.unsubscribe("detection.").unwrap();
        thread::sleep(Duration::from_millis(100));

        sock.send(b"detection.D", b"gone");
        sock.send(b"heartbeat.sdr", b"kept");
        assert_eq!(sub.recv().unwrap().1, "kept");
    }

    /// Nobody listening is the normal startup state, not an error: PUB/SUB
    /// discards with no subscriber by design (ADR-0002). What must not happen is
    /// a block or a panic.
    #[test]
    fn publishing_with_no_subscriber_is_not_an_error() {
        let (sock, _endpoint) = publisher_bound_to_a_free_port();
        let started = std::time::Instant::now();
        for _ in 0..10_000 {
            // The return value is deliberately not asserted: with a 16-slot
            // queue and nothing to receive, some of these legitimately drop.
            // What must hold is that none of them waits.
            sock.send(b"detection.D", b"{}");
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "10k publishes took {:?}; something blocked",
            started.elapsed()
        );
        assert_eq!(sock.published() + sock.dropped(), 10_000);
        assert_eq!(sock.peers(), 0);
    }

    #[test]
    fn a_subscriber_that_hangs_up_is_reaped() {
        let (sock, endpoint) = publisher_bound_to_a_free_port();
        let addr = endpoint.trim_start_matches("tcp://").to_string();
        let sub = FakeSub::handshake(TcpStream::connect(&addr).unwrap()).unwrap();
        wait_for_peer(&sock);
        drop(sub);
        for _ in 0..200 {
            if sock.peers() == 0 {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("a disconnected subscriber stayed in the registry");
    }

    /// A PUB connecting to a PUB is the failure mode of getting the socket modes
    /// wrong on both sides, which is a live risk now that two sensors share one
    /// endpoint. It must be refused with a message naming the cause.
    #[test]
    fn refuses_a_peer_that_is_not_a_subscriber() {
        let (sock, endpoint) = publisher_bound_to_a_free_port();
        let addr = endpoint.trim_start_matches("tcp://").to_string();
        let mut stream = TcpStream::connect(&addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(&greeting()).unwrap();
        let mut theirs = [0u8; GREETING_LEN];
        stream.read_exact(&mut theirs).unwrap();
        let mut properties = Vec::new();
        encode_property(&mut properties, "Socket-Type", "PUB");
        let mut ready = Vec::new();
        encode_command(&mut ready, b"READY", &properties);
        stream.write_all(&ready).unwrap();

        thread::sleep(Duration::from_millis(200));
        assert_eq!(sock.peers(), 0, "a PUB peer was accepted as a subscriber");
    }

    /// Connect mode is the default for this sensor, because the Wi-Fi sensor
    /// already owns the bind side of the endpoint.
    #[test]
    fn connect_mode_dials_out_and_survives_the_peer_being_late() {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let endpoint = format!("tcp://127.0.0.1:{port}");

        // Publisher first, listener second: the reverse of the happy path, and
        // the ordering systemd actually produces about half the time.
        let sock = PubSocket::open(
            &endpoint,
            SocketMode::Connect,
            16,
            Duration::from_millis(100),
        )
        .unwrap();
        assert!(sock.send(b"detection.D", b"into the void"));
        thread::sleep(Duration::from_millis(300));

        let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
        let (tx, rx) = channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut sub = FakeSub::handshake(stream).unwrap();
            sub.subscribe("detection.").unwrap();
            tx.send(sub.recv().unwrap()).unwrap();
        });

        wait_for_peer(&sock);
        thread::sleep(Duration::from_millis(150));
        for _ in 0..50 {
            sock.send(b"detection.D", b"after reconnect");
            if let Ok(msg) = rx.recv_timeout(Duration::from_millis(100)) {
                assert_eq!(msg.1, "after reconnect");
                return;
            }
        }
        panic!("nothing arrived after the subscriber came up");
    }

    #[test]
    fn reads_a_multipart_message_from_a_buffered_reader() {
        // Guards against the reader assuming one syscall per frame.
        let mut buf = Vec::new();
        encode_frame(&mut buf, b"heartbeat.sdr", FLAG_MORE);
        encode_frame(&mut buf, b"{\"healthy\":true}", 0);
        let mut r = BufReader::new(buf.as_slice());
        let frames = read_message(&mut r).unwrap();
        assert_eq!(frames[0].body, b"heartbeat.sdr");
        assert_eq!(frames[1].body, b"{\"healthy\":true}");
    }
}

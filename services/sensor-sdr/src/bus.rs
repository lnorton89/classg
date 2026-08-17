//! The ClassG detection bus, as this sensor speaks it.
//!
//! [`zmtp`](crate::zmtp) is the wire; this is the vocabulary. Both are copied
//! from `classg_wifi/bus.py` rather than invented, because fusion and the API
//! make no distinction between sensors: a heartbeat whose shape differs by a
//! field name would degrade `/health` for a sensor that is working perfectly.
//!
//! Topics, matching ADR-0002 and the Wi-Fi sensor exactly:
//!
//! ```text
//! detection.<class>   e.g. detection.D
//! heartbeat.<kind>    e.g. heartbeat.sdr
//! ```

use std::time::Duration;

use serde_json::json;

use crate::clock;
use crate::detection::Detection;
use crate::zmtp::{PubSocket, SocketMode};

/// What the ADS-B loop needs from the bus.
///
/// A trait so the loop can be tested against a recording fake -- the loop's
/// reconnect and heartbeat behaviour is the part worth testing, and none of it
/// should require a socket.
pub trait Bus {
    fn publish(&self, detection: &Detection) -> bool;
    fn heartbeat(&self, healthy: bool, detail: serde_json::Value);
    /// Live subscribers, for the heartbeat's own detail block.
    fn subscribers(&self) -> usize;
}

pub struct DetectionPublisher {
    socket: PubSocket,
    sensor_id: String,
    detection_topic: String,
    heartbeat_topic: String,
}

impl DetectionPublisher {
    pub fn open(
        endpoint: &str,
        mode: SocketMode,
        hwm: usize,
        reconnect_max: Duration,
        sensor_id: &str,
        detection_topic: &str,
        heartbeat_topic: &str,
    ) -> std::io::Result<Self> {
        Ok(Self {
            socket: PubSocket::open(endpoint, mode, hwm, reconnect_max)?,
            sensor_id: sensor_id.to_string(),
            detection_topic: detection_topic.to_string(),
            heartbeat_topic: heartbeat_topic.to_string(),
        })
    }
}

impl Bus for DetectionPublisher {
    fn publish(&self, detection: &Detection) -> bool {
        let body = match serde_json::to_vec(detection) {
            Ok(b) => b,
            Err(err) => {
                // Unreachable for this struct, but a silent `?` here would turn
                // a future schema change into a sensor that publishes nothing.
                eprintln!(
                    "{} bus: could not serialise a detection: {err}",
                    clock::now_rfc3339()
                );
                return false;
            }
        };
        let topic = format!("{}{}", self.detection_topic, detection.detection_class);
        self.socket.send(topic.as_bytes(), &body)
    }

    /// Emitted unconditionally, even with nothing detected.
    ///
    /// This is what lets the system tell "no aircraft in range" from "dump1090
    /// is dead" -- the single most important operational property (ADR-0003),
    /// and the reason ADR-0008 calls it out again for this sensor specifically.
    fn heartbeat(&self, healthy: bool, detail: serde_json::Value) {
        let msg = json!({
            "schema_version": "1.0",
            // The Wi-Fi sensor sends epoch seconds here and the API's FlexTime
            // accepts either; RFC3339 matches the detection schema and fusion's
            // own network-ADS-B heartbeat, so it is the better of the two.
            "ts": clock::now_rfc3339(),
            "sensor_id": self.sensor_id,
            "sensor_kind": "sdr",
            "healthy": healthy,
            "published": self.socket.published(),
            "dropped": self.socket.dropped(),
            "detail": detail,
        });
        let topic = format!("{}sdr", self.heartbeat_topic);
        match serde_json::to_vec(&msg) {
            Ok(body) => {
                self.socket.send(topic.as_bytes(), &body);
            }
            Err(err) => eprintln!(
                "{} bus: could not serialise the heartbeat: {err}",
                clock::now_rfc3339()
            ),
        }
    }

    fn subscribers(&self) -> usize {
        self.socket.peers()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection::sample_detection;
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc::channel;
    use std::thread;

    /// A SUB peer that subscribes to everything and reports what it receives.
    ///
    /// Deliberately re-derived from the wire rather than reusing zmtp's test
    /// helpers: this asserts the *topics* the bus layer chooses, which is the
    /// part fusion routes on.
    fn subscriber_on(port: u16) -> std::sync::mpsc::Receiver<(String, String)> {
        let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
        let (tx, rx) = channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Greeting: 0xFF, 8 pad, 0x7F, version 3.0, "NULL", as-server 0.
            let mut greeting = [0u8; 64];
            greeting[0] = 0xFF;
            greeting[9] = 0x7F;
            greeting[10] = 3;
            greeting[12..16].copy_from_slice(b"NULL");
            stream.write_all(&greeting).unwrap();
            let mut theirs = [0u8; 64];
            stream.read_exact(&mut theirs).unwrap();

            // READY, Socket-Type=SUB.
            let mut props: Vec<u8> = vec![11];
            props.extend_from_slice(b"Socket-Type");
            props.extend_from_slice(&3u32.to_be_bytes());
            props.extend_from_slice(b"SUB");
            let mut body = vec![5u8];
            body.extend_from_slice(b"READY");
            body.extend_from_slice(&props);
            stream.write_all(&[0x04, body.len() as u8]).unwrap();
            stream.write_all(&body).unwrap();
            read_one_frame(&mut stream);

            // Subscribe to everything.
            stream.write_all(&[0x00, 0x01, 0x01]).unwrap();

            loop {
                let topic = match try_read_frame(&mut stream) {
                    Some(f) => f,
                    None => return,
                };
                let body = match try_read_frame(&mut stream) {
                    Some(f) => f,
                    None => return,
                };
                if tx
                    .send((
                        String::from_utf8_lossy(&topic).into_owned(),
                        String::from_utf8_lossy(&body).into_owned(),
                    ))
                    .is_err()
                {
                    return;
                }
            }
        });
        rx
    }

    fn read_one_frame(stream: &mut TcpStream) -> Vec<u8> {
        try_read_frame(stream).expect("frame")
    }

    fn try_read_frame(stream: &mut TcpStream) -> Option<Vec<u8>> {
        let mut header = [0u8; 2];
        stream.read_exact(&mut header).ok()?;
        let size = if header[0] & 0x02 != 0 {
            let mut long = [0u8; 8];
            long[0] = header[1];
            stream.read_exact(&mut long[1..]).ok()?;
            u64::from_be_bytes(long) as usize
        } else {
            header[1] as usize
        };
        let mut body = vec![0u8; size];
        stream.read_exact(&mut body).ok()?;
        Some(body)
    }

    fn free_port() -> u16 {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        port
    }

    fn publisher(port: u16) -> DetectionPublisher {
        DetectionPublisher::open(
            &format!("tcp://127.0.0.1:{port}"),
            SocketMode::Connect,
            64,
            Duration::from_millis(50),
            "sdr-0",
            "detection.",
            "heartbeat.",
        )
        .unwrap()
    }

    #[test]
    fn a_detection_goes_out_on_its_class_topic() {
        let port = free_port();
        let rx = subscriber_on(port);
        let pubsock = publisher(port);
        for _ in 0..200 {
            if pubsock.subscribers() > 0 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(150));

        let detection = sample_detection();
        for _ in 0..50 {
            pubsock.publish(&detection);
            if let Ok((topic, body)) = rx.recv_timeout(Duration::from_millis(100)) {
                assert_eq!(topic, "detection.D");
                let v: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(v["adsb"]["icao"], "A1878A");
                assert_eq!(v["sensor_kind"], "sdr");
                return;
            }
        }
        panic!("no detection arrived");
    }

    #[test]
    fn a_heartbeat_goes_out_on_the_kind_topic_in_the_wifi_sensors_shape() {
        let port = free_port();
        let rx = subscriber_on(port);
        let pubsock = publisher(port);
        for _ in 0..200 {
            if pubsock.subscribers() > 0 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(150));

        for _ in 0..50 {
            pubsock.heartbeat(false, json!({"connected": false}));
            if let Ok((topic, body)) = rx.recv_timeout(Duration::from_millis(100)) {
                assert_eq!(topic, "heartbeat.sdr");
                let v: Value = serde_json::from_str(&body).unwrap();
                // Every key the API's `heartbeatMessage` and the Wi-Fi sensor
                // agree on. A rename here reads downstream as a dead sensor.
                assert_eq!(v["schema_version"], "1.0");
                assert_eq!(v["sensor_id"], "sdr-0");
                assert_eq!(v["sensor_kind"], "sdr");
                assert_eq!(v["healthy"], false);
                assert!(v["published"].is_u64());
                assert!(v["dropped"].is_u64());
                assert_eq!(v["detail"]["connected"], false);
                assert!(v["ts"].as_str().unwrap().ends_with('Z'));
                return;
            }
        }
        panic!("no heartbeat arrived");
    }

    /// The whole point of ADR-0003: with dump1090 gone and no aircraft to
    /// report, the sensor must still say something. A publisher with no
    /// subscriber must not block or fail while doing it.
    #[test]
    fn heartbeats_with_nobody_listening_do_not_block() {
        let pubsock = publisher(free_port());
        for _ in 0..1_000 {
            pubsock.heartbeat(false, json!({"connected": false}));
        }
        assert_eq!(pubsock.subscribers(), 0);
    }
}

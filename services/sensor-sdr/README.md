# sensor-sdr

The Rust SDR sensor is reserved for frequencies below 2 GHz: ADS-B context,
sub-GHz control links, and 1.2/1.3 GHz analog FPV envelope detection. It uses
the RTL-SDR V4's usable range and deliberately does not attempt to receive DJI
OcuSync at 2.4 or 5.8 GHz.

## Current state

**ADS-B (Milestone 2) runs.** `classg-sensor-sdr adsb` consumes dump1090's
SBS-1 stream, translates it into schema-conformant Class D detections, mints
ULIDs, and publishes them on the ClassG bus alongside a heartbeat that fires
whether or not aircraft are in range.

**The sweep engine (Milestone 3) measures but does not yet classify.** Retuning
across a band plan, the transform, per-bin power and the noise floor all run
against a real radio — see [Sweeping a band](#sweeping-a-band). What is missing
is the detector: burst cadence against `CONTROL_LINK_RATES_HZ`, clutter
rejection, and emitting Class E/F. That part needs a transmitter to validate
against, and this project does not ship a detector nobody has checked.

`cargo run` with no subcommand prints the band plan and the tuner limits and
returns nonzero.

```bash
cd services/sensor-sdr
cargo test
cargo run -- adsb          # the ADS-B ingest loop
cargo run                  # band plan only; no capture loop selected

# One schema-shaped detection, as CI validates it against schemas/
cargo run -- --emit-sample-detection
```

## Talking to the radio

`RtlSdrSource` is behind the **`rtlsdr` feature, off by default**. Linking
librtlsdr would stop the crate building anywhere the library is absent, and the
CI `rust` job installs no system packages — so the default build stays exactly
as portable as it was, and a Pi opts in:

```bash
cargo build --release --features rtlsdr
./target/release/classg-sensor-sdr probe          # enumerate only
./target/release/classg-sensor-sdr probe --open   # tune 915 MHz, read a burst
./target/release/classg-sensor-sdr sweep --band ism_915   # measure a whole band
```

Plain `probe` counts and names devices without touching a USB endpoint, so it
answers "is the radio there" **while dump1090 holds it** — which on a working
unit it always does ([ADR-0008](../../docs/architecture/adr/0008-adsb-via-dump1090.md)).
`--open` needs the radio to itself and will fail with `librtlsdr -6` otherwise;
that is the correct answer, not a fault.

The binding is hand-written rather than the `rtlsdr` crate, which wraps stock
librtlsdr — the V4 needs the RTL-SDR Blog fork, and a working `--open` prints
`RTL-SDR Blog V4 Detected` to prove which library it found. If the linker
cannot find it, point `RTLSDR_LIB_DIR` at the install prefix; `build.rs`
otherwise asks `pkg-config` and falls back to `/usr/local/lib`, where the
fork's own build instructions leave it.

## ADS-B

This sensor does not demodulate Mode S itself. `dump1090` owns the radio and
does the CRC checking and position decoding; we consume its decoded stream and
translate. The reasoning, and the consequence that Milestone 3's sweep cannot
share the same dongle, are in
[ADR-0008](../../docs/architecture/adr/0008-adsb-via-dump1090.md).

Start dump1090 separately — this process never opens the device:

```bash
dump1090 --net            # SBS-1 output on 30003
cargo run -- adsb
```

### Configuration

Environment only, per [ADR-0007](../../docs/architecture/adr/0007-configuration-tiers.md).
`adsb` prints every effective value **and where it came from** at startup, which
is the part of that ADR that matters. The nearest `.env` is loaded the way the
API, fusion and the Wi-Fi CLI load it; anything already in the process
environment wins.

| Variable | Default | |
|---|---|---|
| `CLASSG_SDR_SENSOR_ID` | `sdr-0` | matches `CLASSG_EXPECTED_SENSORS` |
| `CLASSG_SDR_DUMP1090_ADDR` | `127.0.0.1:30003` | dump1090's SBS-1 port |
| `CLASSG_DETECTION_ENDPOINT` | `tcp://127.0.0.1:5556` | shared with the other sensors |
| `CLASSG_DETECTION_TOPIC` | `detection.` | |
| `CLASSG_HEARTBEAT_TOPIC` | `heartbeat.` | |
| `CLASSG_SDR_SOCKET_MODE` | `connect` | `bind` or `connect` |
| `CLASSG_SDR_ZMQ_HWM` | `1000` | outbound queue; overflow drops and counts |
| `CLASSG_SDR_HEARTBEAT_S` | `10` | |
| `CLASSG_SDR_RECONNECT_MAX_S` | `30` | backoff ceiling for both dump1090 and the bus |

**`CLASSG_SDR_SOCKET_MODE` defaults to `connect`, unlike the Wi-Fi sensor's
`bind`.** Two PUB sockets cannot bind the same endpoint, and `sensor-wifi`
already owns the bind side in the all-native layout. Running both sensors
therefore means fusion listens (`CLASSG_FUSION_DETECTION_SOCKET_MODE=listen`) and
both sensors dial out — the same direction the Compose layout already uses. Get
it wrong and the handshake is refused with the peer's socket type in the log
rather than failing silently.

### Degradation

dump1090 not running, refusing connections, or dying mid-stream are expected
states, not faults ([ADR-0003](../../docs/architecture/adr/0003-sensor-process-isolation.md)).
Each reconnects with bounded backoff and reports `healthy: false` with the
reason in the heartbeat's `detail.error`.

**A quiet sky is healthy.** Health tracks the link to dump1090, not the presence
of aircraft; `detail.seconds_since_message` is what tells an operator the
difference. Lines that do not parse — STA/ID/AIR session records, partial reads
at a TCP boundary — are counted in `detail.unparsed` and never fatal.

### The bus, without a ZeroMQ crate

`src/zmtp.rs` implements the PUB half of ZMTP 3.0 directly on `std::net`. The
`zmq` crate links libzmq, which the CI `rust` job cannot build; `zeromq`
(zmq.rs) is pure Rust but adds 84 crates and a Tokio runtime, and its PUB socket
awaits slow subscribers with no high-water mark — the one behaviour ADR-0002
rules out. The header comment in that file has the full reasoning and the
`go-zeromq/zmq4` behaviour it was written against.

Future capture work must characterize signal envelopes only; it must not
demodulate control or video payloads. See [ADR-0004](../../docs/architecture/adr/0004-rtlsdr-scope.md)
and [the legal guidance](../../docs/research/06-legal-and-ethics.md).

## Sweeping a band

`sweep` retunes across a band plan, transforms each slice, and reports where the
energy is and what the floor under it looks like. Bands come from `BAND_PLANS`:
`ism_915`, `ism_868`, `ism_433`, `fpv_1g2`.

```
ism_915 -- 902.000-928.000 MHz in 14 steps
    902.960 MHz  peak   -65.5 dBFS at   902.341 MHz
    ...
noise floor -70.5 dBFS (median), +10 dB threshold -60.5 dBFS
nothing above threshold in this band right now.
```

**It measures; it does not classify.** Deciding that a burst train is ELRS rather
than a smart meter is the detector, it needs a transmitter to validate against,
and the roadmap is explicit that an unvalidated detector is worse than none. So
this prints energy and claims nothing about what produced it.

The DC guard is the part worth knowing about. The RTL-SDR is zero-IF, so its own
local oscillator lands at the tuned frequency and appears as a spike at the
centre of every slice. The first version of this sweep trusted the raw peak and
reported a detection at the exact centre of all fourteen steps — the receiver
detecting itself, fourteen times, about 12 dB over the floor. `peak_excluding_dc`
skips a three-bin guard, and the step overlap in `plan_sweep` covers the ~16 kHz
notch that creates. Every synthetic-tone test passed before that fix; only real
spectrum showed it.
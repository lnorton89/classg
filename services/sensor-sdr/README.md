# sensor-sdr

The Rust SDR sensor is reserved for frequencies below 2 GHz: ADS-B context,
sub-GHz control links, and 1.2/1.3 GHz analog FPV envelope detection. It uses
the RTL-SDR V4's usable range and deliberately does not attempt to receive DJI
OcuSync at 2.4 or 5.8 GHz.

## Current state

The crate provides tested sweep planning, source abstractions, noise-floor
scaffolding, and the ADS-B translation layer: `sbs.rs` turns dump1090's SBS-1
output into schema-conformant Class D detections. `cargo run` prints the planned
bands, explains the tuner limits, and returns a nonzero status because hardware
capture and bus publication are not implemented yet.

```bash
cd services/sensor-sdr
cargo test
cargo run

# One schema-shaped detection, as CI validates it against schemas/
cargo run -- --emit-sample-detection
```

## ADS-B

This sensor does not demodulate Mode S itself. `dump1090` owns the radio and
does the CRC checking and position decoding; we consume its decoded stream and
translate. The reasoning, and the consequence that Milestone 3's sweep cannot
share the same dongle, are in
[ADR-0008](../../docs/architecture/adr/0008-adsb-via-dump1090.md).

Still to come for Milestone 2: the TCP client for port 30003, ULID minting, the
ZeroMQ publisher, and a heartbeat that fires whether or not aircraft are in
range — a quiet sky and a dead dump1090 produce identical detection streams, and
only the heartbeat tells them apart ([ADR-0003](../../docs/architecture/adr/0003-sensor-process-isolation.md)).

Future capture work must characterize signal envelopes only; it must not
demodulate control or video payloads. See [ADR-0004](../../docs/architecture/adr/0004-rtlsdr-scope.md)
and [the legal guidance](../../docs/research/06-legal-and-ethics.md).

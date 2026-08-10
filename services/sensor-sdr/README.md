# sensor-sdr

The Rust SDR sensor is reserved for frequencies below 2 GHz: ADS-B context,
sub-GHz control links, and 1.2/1.3 GHz analog FPV envelope detection. It uses
the RTL-SDR V4's usable range and deliberately does not attempt to receive DJI
OcuSync at 2.4 or 5.8 GHz.

## Current state

The crate currently provides tested sweep planning, source abstractions, and
noise-floor scaffolding. `cargo run` prints the planned bands, explains the
tuner limits, and returns a nonzero status because hardware capture and bus
publication are not implemented yet.

```bash
cd services/sensor-sdr
cargo test
cargo run
```

Future capture work must characterize signal envelopes only; it must not
demodulate control or video payloads. See [ADR-0004](../../docs/architecture/adr/0004-rtlsdr-scope.md)
and [the legal guidance](../../docs/research/06-legal-and-ethics.md).

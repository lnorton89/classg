# Services

ClassG is deliberately split into independently deployable processes. Sensors
make immutable detections, `fusion` correlates them into tracks, and `api`
exposes those tracks to the operator UI. The shared payload contract lives in
[`../schemas/`](../schemas/).

| Module | Language | Responsibility | Status |
|---|---|---|---|
| [`sensor-wifi/`](sensor-wifi/) | Python | Wi-Fi Remote ID, DJI DroneID, and fingerprints | Live: capture, replay, analyze, and the hopping live loop (`run`) under systemd. Milestone 1 exit met against a real flight, 2026-08-10 |
| [`sensor-sdr/`](sensor-sdr/) | Rust | ADS-B context and sub-2 GHz sensing | ADS-B ingest via dump1090 (`adsb`), ZMTP publisher, `probe`, and the band sweep engine all run (Milestone 2). Sub-2 GHz *detection* classes are Milestone 3, not started |
| [`sensor-ble/`](sensor-ble/) | Python | Bluetooth Remote ID | Planned (Milestone 4); requires an additional BLE dongle |
| [`fusion/`](fusion/) | Go | Detection-to-track correlation and confidence | Implemented, including ADS-B correlation and false-positive suppression |
| [`api/`](api/) | Go | REST/GraphQL/WebSocket, storage, accounts | Implemented: libSQL persistence with retention, sessions and roles, optional OIDC |
| [`ui/`](ui/) | TypeScript | Operator map, timeline, spectrum, admin | Implemented |

Status per milestone, with exit-criterion evidence: [the roadmap](../docs/planning/roadmap.md).

The services communicate over the detection bus; a sensor must continue to
report health even when it has no detections. This makes a quiet sky
distinguishable from a failed receiver. See the [architecture overview](../docs/architecture/overview.md).

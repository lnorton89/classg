# Services

ClassG is deliberately split into independently deployable processes. Sensors
make immutable detections, `fusion` correlates them into tracks, and `api`
exposes those tracks to the operator UI. The shared payload contract lives in
[`../schemas/`](../schemas/).

| Module | Language | Responsibility | Status |
|---|---|---|---|
| [`sensor-wifi/`](sensor-wifi/) | Python | Wi-Fi Remote ID, DJI DroneID, and fingerprints | Capture, replay, and parsing implemented; live loop pending |
| [`sensor-sdr/`](sensor-sdr/) | Rust | Sub-2 GHz ADS-B and signal-envelope sensing | Band-planning scaffolding; capture pending |
| [`sensor-ble/`](sensor-ble/) | Python | Bluetooth Remote ID | Planned; requires an additional BLE dongle |
| [`fusion/`](fusion/) | Go | Detection-to-track correlation and confidence | Implemented library |
| [`api/`](api/) | Go | REST/WebSocket API and storage | Implemented |
| [`ui/`](ui/) | TypeScript | Operator map and health views | Implemented |

The services communicate over the detection bus; a sensor must continue to
report health even when it has no detections. This makes a quiet sky
distinguishable from a failed receiver. See the [architecture overview](../docs/architecture/overview.md).

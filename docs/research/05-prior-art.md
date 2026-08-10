# Prior art survey

What exists, what to borrow, what to avoid rebuilding.

## Reference implementations worth reading

### [opendroneid/opendroneid-core-c](https://github.com/opendroneid/opendroneid-core-c)
The normative ASTM F3411-22a implementation. Encodes and decodes every message type.
**Use as:** ground truth for the parser, and as a test-vector generator.
**Consider:** binding to it via `cffi` instead of maintaining a pure-Python parser, if
field-level accuracy becomes a maintenance burden. Deferred — a pure-Python parser is easier
to debug during bring-up, and the vector corpus makes the swap safe later.

### [cyber-defence-campus/RemoteIDReceiver](https://github.com/cyber-defence-campus/RemoteIDReceiver)
Closest architectural sibling: Python backend, REST + WebSocket, Vue + MapLibre frontend,
offline TileServer. Explicitly a proof of concept, BLE and Wi-Fi NAN unimplemented.
**Borrow:** the offline-tileserver approach, the REST+WS split.
**Improve on:** sensor process isolation, and BLE support.

### [alphafox02/WarDragon](https://github.com/alphafox02/WarDragon) + DragonSync
The most complete open architecture in this space. Multiple radios feeding a **ZMQ bus**,
deduplication by drone serial across protocols, output to TAK/MQTT.
**Borrow directly:** ZMQ as the sensor bus, and serial-number-keyed cross-protocol dedup.
Both are validated design choices, and ClassG adopts them
([ADR-0002](../architecture/adr/0002-message-bus-zeromq.md)).
Note its DJI OcuSync decode uses a **wideband SDR**, not an RTL — consistent with our analysis.

### [Kismet](https://github.com/kismetwireless/kismet)
Mature Wi-Fi/BT capture framework with built-in DJI DroneID IE parsing
(`dot11_ie_221_dji_droneid`) and Kaitai struct definitions.
**Borrow:** the field layouts, as the best-documented public reference.
**Consider as alternative:** running Kismet as the capture layer and consuming its REST feed,
instead of writing a sniffer. Rejected for ClassG — see
[ADR-0005](../architecture/adr/0005-own-sniffer-vs-kismet.md) — but it is a legitimate path
and a good fallback if monitor-mode handling proves painful.

### [bkerler/DroneID](https://github.com/bkerler/DroneID)
Practical DJI receiver; `dji_receiver.py` emits JSON over ZMQ. Useful as an interface
reference for what a sensor should publish.

### [alphafox02/droneid-go](https://github.com/alphafox02/droneid-go)
High-performance Go ODID decoder. Relevant if the Python parser becomes a bottleneck —
unlikely at ~1 Hz beacon rates, but it validates Go as a viable home for the decode path.

### [nccgroup/Sniffle](https://github.com/nccgroup/Sniffle)
BLE sniffer firmware for nRF52840 / CC1352. **The** answer for BT5 Long Range Remote ID.
Pairs with `SniffleToTak` for TAK output. This is the recommended add-on.

### Smaller / narrower
- [iannil/open-remote-id-parser](https://github.com/iannil/open-remote-id-parser) — C++ ODID
  parser covering all four transports; useful cross-check.
- [Jacob-Haynes/drone-detector](https://github.com/Jacob-Haynes/drone-detector) — Pi 5 +
  Wi-Fi, DJI DroneID + Remote ID + OUI classification. Very close to ClassG's Milestone 1.
- [hugsy/dji-joe](https://github.com/hugsy/dji-joe) — minimal monitor-mode DJI MAC scanner.
- [smittix/intercept](https://github.com/smittix/intercept) — RTL-SDR + BT + Wi-Fi platform.
- [opendroneid/receiver-android](https://github.com/opendroneid/receiver-android) — reference
  Android receiver; its supported-smartphones list is a good record of which chipsets can
  actually receive BT5 Coded PHY.

---

## What the survey establishes

**Settled, don't re-derive:**
- ZMQ as the multi-sensor bus, with serial-number dedup across protocols (WarDragon)
- Wi-Fi Beacon Remote ID + DJI IE 221 as the practical Pi-class detection path
- `opendroneid-core-c` as protocol ground truth
- nRF52840 + Sniffle as the only sane BT5 Long Range path
- Wideband SDR as a hard requirement for OcuSync decode

**Genuinely open, where ClassG can contribute:**
- **Channel-hopping strategy under 1 Hz beacons.** Every project hops; nobody publishes dwell
  optimisation. This is the highest-leverage tuning problem and it is measurable.
- **Sub-2 GHz control-link detection.** Consistently "planned" and rarely shipped. It is the
  main path to detecting non-compliant aircraft, and it is exactly what the RTL-SDR can do.
- **Honest confidence scoring.** Most projects treat any hit as a detection. Multi-sensor
  evidence weighting with calibrated confidence is largely unaddressed.
- **False-positive suppression via ADS-B correlation.** Rarely combined despite both radios
  being present in most builds.

**Deliberately out of scope:** anything transmitting. No jamming, no spoofing, no takeover, no
deauthentication. See [06-legal-and-ethics.md](06-legal-and-ethics.md). Note that several
repositories adjacent to this survey (`DJIDroneIDspoofer`, `droneIDspoofer`) do transmit —
they are listed nowhere above for that reason and are not references for this project.

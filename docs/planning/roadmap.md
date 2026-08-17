# Roadmap

Ordered so that each milestone produces something verifiable with the hardware on hand.

**Guiding rule:** nothing gets built on an assumption your DJI hasn't confirmed. The capture
corpus from Milestone 0 is the foundation for everything after it.

---

## Milestone 0 — Bring-up and ground truth
*Goal: prove the hardware works and capture real frames from the DJI.*

Everything downstream is built against these captures. Do not skip ahead.

- [x] Pi OS install, kernel ≥ 5.18 verified (`uname -r`) — Bookworm, 6.12.96
- [x] AWUS036AXML enumerates, firmware loads, **passive** monitor mode holds for 1 hour — held 4 h 11 min on the Pi, 2026-08-16
- [x] `btusb` disabled per the MT7921 Wi-Fi/BT conflict
- [x] RTL-SDR V4 working with the **rtl-sdr-blog driver fork** (stock librtlsdr will not do) — R828D recognised, 0 samples per million lost
- [x] `dvb_usb_rtl28xxu` blacklisted
- [ ] Both radios stable simultaneously for 1 hour — this is the USB power test
- [x] **Capture DJI power-on → hover → land as PCAP** — `captures/20260810-141223-dji-first-flight.pcap`
- [x] Manually confirm in Wireshark: IE 221 present, OUI `26:37:12` and/or `FA:0B:BC` — F3411 `fa:0b:bc` present, `26:37:12` absent for this aircraft
- [x] Record which **channel** the DJI actually beacons on — channel 6, 176 drone beacons
- [x] Record beacon **interval** — verify the ~1 Hz assumption — 240 ms median, ~4.17 Hz; the 1 Hz assumption was wrong
- [x] `dump1090` decoding real aircraft — `captures/20260811-113000-adsb-frames-avr.txt`

The USB power test is the one item still open, and it is not a formality. On
2026-08-16 the AWUS036AXML dropped off the bus after 4 h 11 min alongside the
SDR, with no undervoltage recorded (`throttled=0x0`) — so a clean disconnect
rather than the brownout [01-pi-setup](../ops/01-pi-setup.md) warns about.
Cause unestablished. Run the hour deliberately, with both radios streaming,
before trusting a field deployment.

`dump1090` proved the decode path on the previous host; it is **not installed
on the Pi**, which is the first task of Milestone 2 rather than a gap here.

**Exit criterion:** a PCAP in `captures/` containing verified drone beacons, and a written
note of the drone's model, firmware version, observed channel, and beacon rate.

**Reassessment gate:** if monitor mode is not reliably capturing beacons after a week,
invoke the Kismet fallback in [ADR-0005](../architecture/adr/0005-own-sniffer-vs-kismet.md).

---

## Milestone 1 — Wi-Fi detection end to end
*Goal: the DJI appears on a map.*

- [x] `sensor-wifi` capture loop with **passive** monitor mode
- [x] Weighted channel hopper, config-driven
- [x] ODID parser: Message Pack, Basic ID, Location, System, Operator ID
- [x] DJI parser: subcommand `0x10` and `0x11`
- [x] **Calibrate DJI units** — N/A for this aircraft: the Mini 5 Pro emits no proprietary DJI Wi-Fi IE, so there are no raw DJI fields to calibrate ([04-calibration.md](../ops/04-calibration.md))
- [x] OUI/SSID fingerprint matcher, YAML-driven
- [x] Detection schema validation in CI
- [x] ZMQ publisher with HWM and drop counters
- [x] `fusion`: track lifecycle, serial/MAC correlation, noisy-OR confidence
- [x] `api`: REST `/tracks`, `/health`, WebSocket `/api/v1/stream`
- [x] `ui`: MapLibre map, live track markers, track detail panel
- [x] Health endpoint distinguishes "no drones" from "sensor broken"

**Exit criterion:** fly the DJI, watch it appear and move on the map in real time, with the
correct serial number.

**MET — 2026-08-10 20:07.** Live flight detected end to end: 473 beacons captured, 222
detections, one track with the correct serial and a 222-point flight path. Dwell escalation
locked to channel 6 ten seconds in. See
[04-calibration.md](../ops/04-calibration.md#confirmed-by-live-detection--2026-08-10-2007).

---

## Milestone 2 — ADS-B and airspace context
*Goal: manned aircraft on the same map; false-positive suppression working.*

- [ ] `sensor-sdr` skeleton in Rust: `SdrSource` trait, `RtlSdrSource` implementation
- [ ] `dump1090` integration → Class D detections
- [ ] Fusion: ADS-B correlation and suppression logic for Class E/F
- [ ] UI: distinct rendering for manned traffic
- [ ] Graceful degradation when the SDR is absent

**Exit criterion:** manned aircraft appear on the map, visually distinct from drone tracks.

---

## Milestone 3 — Sub-2 GHz detection
*Goal: detect an aircraft that broadcasts no Remote ID at all.*

This is where the SDR earns its place.

- [ ] Sweep engine: retune + FFT + per-bin power over 902–928 MHz
- [ ] Noise-floor estimation and adaptive thresholding
- [ ] Burst cadence detection (50/100/200 Hz ELRS signatures)
- [ ] Clutter rejection: LoRaWAN, Meshtastic, smart meters
- [ ] 433 MHz and 1.2 GHz FPV band support
- [ ] Class E/F detections with `signal_features` populated
- [ ] **Hard constraint check:** no demodulation of payload or video content

**Exit criterion:** an ELRS or Crossfire transmitter produces a Class E detection while
a comparable-power non-drone 915 MHz emitter (smart meter, Meshtastic node) does not.

⚠️ Needs a test transmitter you do not currently own. An ELRS module or a friend's FPV setup
is required for validation — an unvalidated detector here is worse than none.

---

## Milestone 4 — Bluetooth Remote ID
*Goal: close the largest coverage gap.*

Requires an **nRF52840 dongle** (~$25). Highest detection-coverage-per-dollar upgrade available.

- [ ] Flash Sniffle firmware
- [ ] `sensor-ble`: serial protocol, BT4 legacy + BT5 Coded PHY
- [ ] Reuse the ODID parser from `sensor-wifi`
- [ ] Fusion: cross-transport dedup by serial (same aircraft on Wi-Fi and BLE = one track)

**Exit criterion:** a BLE-only Remote ID broadcaster produces a track; a drone broadcasting on
both transports produces exactly **one** track, not two.

---

## Milestone 5 — Operational hardening

- [x] systemd units with bounded restart backoff — [deploy/systemd](../../deploy/systemd), rendered per checkout
- [ ] libSQL/Turso storage, retention jobs, **separate operator-location store, never synced**
- [ ] Prometheus metrics, including hopper efficiency
- [ ] Offline tile server for field deployment
- [x] Docker Compose for the web tier — fusion, api and ui, `restart: unless-stopped`
- [ ] Config validation on startup with clear errors

Bookworm ships systemd 252, which has no `RestartSteps`, so the backoff is
bounded rather than escalating: five failures inside five minutes and the unit
stops in `failed`, where `systemctl status` and the dashboard both show it.
Proven twice on 2026-08-16 — once by killing the process (restarted, one
`NRestarts`), once by the adapter genuinely vanishing (retried, gave up, and
the API reported `status: down` with the reason rather than a quiet sky).

---

## Backlog

- GNSS L1 interference monitoring (Class H)
- Wi-Fi NAN transport
- Two Wi-Fi adapters: one parked on ch 6, one sweeping — removes the dwell tradeoff entirely
- Directional antenna + sector switching for crude bearing
- Multi-node sensor deployment (this is when MQTT gets reconsidered)
- TAK/CoT export — **must default to omitting operator location**
- OcuSync DroneID decode — requires wideband SDR, see [ADR-0004](../architecture/adr/0004-rtlsdr-scope.md)

## Explicitly never

Anything that transmits. No jamming, spoofing, deauth, or takeover.
See [06-legal-and-ethics.md](../research/06-legal-and-ethics.md).

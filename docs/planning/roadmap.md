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
- [x] Both radios stable simultaneously for 1 hour — 2 h 10 min on 2026-08-17, no USB disconnects
- [x] **Capture DJI power-on → hover → land as PCAP** — `captures/20260810-141223-dji-first-flight.pcap`
- [x] Manually confirm in Wireshark: IE 221 present, OUI `26:37:12` and/or `FA:0B:BC` — F3411 `fa:0b:bc` present, `26:37:12` absent for this aircraft
- [x] Record which **channel** the DJI actually beacons on — channel 6, 176 drone beacons
- [x] Record beacon **interval** — verify the ~1 Hz assumption — 240 ms median, ~4.17 Hz; the 1 Hz assumption was wrong
- [x] `dump1090` decoding real aircraft — `captures/20260811-113000-adsb-frames-avr.txt`

The hour is met; the four-hour question is not. On 2026-08-17 both radios ran
2 h 10 min together from a 09:51:12 boot — all three units at `NRestarts=0`, zero
disconnects, over-currents or descriptor-read errors in `dmesg`, `throttled=0x0`
at 40.4 °C. Both were streaming rather than merely enumerated: the Wi-Fi sensor
climbed to 11,548 beacons and ADS-B messages kept arriving across the window.

That clears the exit criterion as written. The 2026-08-16 failure — when the
AWUS036AXML dropped off the bus after 4 h 11 min alongside the SDR with no
undervoltage recorded, a clean disconnect rather than the brownout
[01-pi-setup](../ops/01-pi-setup.md) warns about — **did not reproduce.** The
same session was sampled straight through and past that mark:

```
up_s   wall      sdr wifi  usb_err  throttled      temp
14907  13:59:39   1    1      0     throttled=0x0  42.8'C
15027  14:01:39   1    1      0     throttled=0x0  43.3'C   <- 4 h 11 min
15268  14:05:40   1    1      0     throttled=0x0  42.8'C
```

115 samples over the run, no sample missing either radio, no USB disconnects or
over-currents in `dmesg`, and all three units still at `NRestarts=0`.

**This is not a fix, because nothing was fixed.** One clean pass through the
window says the failure is not deterministic at 4 h 11 min; it does not
establish what caused it, and an intermittent bus fault is exactly the kind that
survives a single good run. Treat it as one datum against a repeat, and run
[`scripts/usb-soak.sh`](../../scripts/usb-soak.sh) again on the deployment that
matters.

[`scripts/usb-soak.sh`](../../scripts/usb-soak.sh) is what to run for that. It
samples both radios' bus presence *and* a counter that only advances while
frames arrive, because a radio can stay enumerated with its driver no longer
delivering — which reads as healthy to `lsusb` and as a quiet sky to an
operator.

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

- [x] `sensor-sdr` skeleton in Rust: `SdrSource` trait, `RtlSdrSource` implementation — hand-written librtlsdr FFI behind the `rtlsdr` feature; `probe --open` read 16,384 samples at 915 MHz on the unit, 2026-08-17
- [x] `dump1090` integration → Class D detections — `sensor-sdr adsb`, published over a hand-written ZMTP PUB
- [x] Fusion: ADS-B correlation and suppression logic for Class E/F — `netadsb.go`, `aircraftdb.go`; Class D is pinned at 0.00 confidence, so it only ever explains a detection away
- [x] UI: distinct rendering for manned traffic — the "Manned traffic" section of `contacts-panel.tsx`
- [x] Graceful degradation when the SDR is absent — verified on the Pi by stopping dump1090 mid-run: `healthy: false` with the refusal in `detail.error`, process alive, reconnected 31 s later with `reconnects: 1`

`dump1090-mutability` is installed on the Pi and decoding live aircraft
(2026-08-16: ASA1413 at 25,175 ft, RSSI −28.4). Two things were needed that the
docs did not mention:

- Its own `dump1090` user is not in `plugdev`, and the rtl-sdr udev rule grants
  `MODE="0660" GROUP="plugdev"`, so it starts, fails with `usb_open error -3`,
  and keeps running with no radio. `usermod -aG plugdev dump1090` fixes it.
  Widening the udev rule to 0666 would too, and would hand every local user the
  radio, so prefer the group.
- Reception is bursty. Six minutes can pass with `peak_signal` equal to
  `noise` and no aircraft at all, then 120 messages arrive at once. Do not
  diagnose a receiver from one short window; `stats.json` separates
  `local.accepted` (the radio) from `remote.accepted` (anything injected).

Frames captured earlier replay into port 30001 and come back out as SBS on
30003, which exercises the whole decode path with no radio and no aircraft.

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
- [x] libSQL/Turso storage, retention jobs — `internal/store/libsqlstore`, with `retention.go` and `stale_tracks.go` sweeping on a timer. The **separate operator-location store is dropped**, not outstanding: [ADR-0006](../architecture/adr/0006-storage-turso-libsql.md) records the operator deciding that syncing pilot ground positions is acceptable for this deployment, and names the `Store` interface as where the separation goes back in for anyone redeploying under GDPR
- [x] Prometheus metrics, including hopper efficiency — `GET /metrics`, hand-written exposition off the same report `/health` returns; sensor `detail` exported through an allowlist so ADR-0006 data cannot leak into a scrape
- [x] Offline tile server for field deployment — achieved with **no tile server**: [`fetch-basemap.sh`](../../scripts/fetch-basemap.sh) cuts two `.pmtiles` archives that whatever already serves the app serves directly, so there is no proxy and no upstream to be offline from
- [x] Docker Compose for the web tier — fusion, api and ui, `restart: unless-stopped`
- [x] Config validation on startup with clear errors — all four services: `api` accumulates every fault before exiting (`config.go`), `sensor-sdr` returns `Result<_, Vec<String>>` the same way, `fusion` names the key and the value it rejected and range-checks the receiver position, `sensor-wifi` gets it from argparse type conversion, which applies to environment-supplied defaults too

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

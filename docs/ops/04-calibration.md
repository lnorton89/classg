# DJI field calibration record

## Confirmed from first observation — 2026-08-10

Ground truth from the [OpenDroneID Android receiver](https://github.com/opendroneid/receiver-android),
drone at ~10 m, before any capture on our own hardware.

**Aircraft: DJI Mini 5 Pro.**

| Property | Observed |
|---|---|
| **Transport** | **Wi-Fi Beacon** ✅ |
| Protocol version | 2 (within our supported 0–2) |
| RSSI at ~10 m | −35 dBm |
| Transmitter OUI | `8c:1e:d9` — *not* in our fingerprint list, vendor unverified |
| UAS ID type | Serial number (ANSI/CTA-2063-A) |
| Serial structure | `1581` + `F` + 15 chars → manufacturer code **1581 = DJI** |
| UA type | Helicopter_or_Multirotor |
| Status | Airborne |

**Messages broadcast:** Basic ID, Location, System/Operator.
**Empty:** Operator ID, Self ID, Authentication.

**Fields present:** geodetic altitude, height (over **takeoff**, not AGL), horizontal and
vertical speed, horizontal/vertical/speed accuracy, timestamp.

**Fields deliberately absent** (invalid sentinels — a parser that invents numbers here is
wrong): pressure altitude, direction, barometric accuracy.

**Operator location is being broadcast**, with location type `Dynamic` (live from the
controller's GPS), including operator altitude. This is the sensitive field — see
[retention](../architecture/data-model.md#retention).

### What this settles

1. **The Wi-Fi sensor is the right sensor.** Wi-Fi Beacon transport is confirmed, so the
   AWUS036AXML will see this aircraft. No Bluetooth dongle is needed to detect *this* drone.
2. **Class A (ASTM F3411) is the live detection path**, not Class B.
3. The parser's handling of absent fields is correct — verified in `tests/test_real_drone.py`.

### Resolved: the Mini 5 Pro did not emit proprietary DJI DroneID

The first monitor-mode capture, `20260810-141223-dji-first-flight.pcap`, contained 176 ASTM
F3411 Remote ID beacons and zero proprietary DJI vendor IEs (`26:37:12`). All 779 captured
beacons parsed without error. For this aircraft, Class A is the live detection path and DJI
raw-field calibration is not applicable.

This matches the prediction: the proprietary Wi-Fi DroneID belongs to DJI's older
Wi-Fi-link drones. The Mini 5 Pro uses OcuSync, which carries DJI's own DroneID on the
2.4/5.8 GHz link — [out of reach of both our radios](../architecture/adr/0004-rtlsdr-scope.md) —
while standards-compliant Remote ID goes out over Wi-Fi Beacon.

If the first capture shows Class A only and no Class B, that is the expected result and not a
bug. It would also mean **the DJI raw-field calibration below is moot for this aircraft**, and
the `SCALES` constants in `parsers/dji.py` stay unvalidated until a DJI Wi-Fi-mode drone is
available. Note that in the results section rather than chasing it.

### Caveat on beacon interval

The app reported `Msg Δ 12.6 s`. **Do not take this as the beacon rate.** Android throttles
Wi-Fi scans for apps (roughly 4 scans per 2 minutes), so the phone cannot observe the true
interval. Only a monitor-mode capture can, which is exactly what
`classg_wifi.cli analyze` measures. The PCAP measured a 240 ms median interval across 175
deltas, approximately 4.17 Hz. The prior ~1 Hz assumption is wrong for this aircraft.

Distribution, so the median is not mistaken for a clean 4 Hz metronome:

| Bucket | Count |
|---|---|
| 50–150 ms | 58 |
| 150–350 ms | 115 |
| 350–700 ms | 1 |
| >1.5 s | 1 (a 21 s gap during power-up / GPS acquisition) |

174 of 175 intervals are under 700 ms; sustained average over the 58 s capture is 3.0
beacons/s. Design impact is in
[01-rf-landscape.md](../research/01-rf-landscape.md#the-dwell-time-problem--measured-and-smaller-than-assumed):
a 400 ms dwell catches a beacon ~81% of the time rather than ~33%, so channel hopping is far
more forgiving than the design assumed. The weighting stays, because F3411 only mandates 1 Hz
and a different aircraft can put us straight back in the hard regime.

### Also observed: the SSID embeds the serial

The beacon SSID is literally **`RID-1581F0000000FAKE0001`** — the `RID-` prefix followed by the
CTA-2063-A serial. That identifies the vendor with no OUI lookup and no payload parsing at all,
and it survives MAC randomisation.

Added to `data/oui_fingerprints.yaml` as `rid-1581*` → DJI. A generic `rid-*` pattern maps to
`unknown_remote_id` rather than DJI: attributing every Remote ID SSID to the one vendor we
happen to have tested would manufacture exactly the false positives Class C is already prone
to.

### Message pack contents

Each 83-byte IE carries a 3-message pack: Basic ID + Location + System. Confirmed against real
bytes in `tests/test_vectors_real.py`.

**Operator location is not in every beacon.** The earliest beacons decode to
`operator_lat=None` — the controller had no GPS fix yet, so the System message carries the 0,0
sentinel. A missing operator position is normal startup behaviour, not a decode failure and not
only a consequence of the redaction flag. The UI must treat it as ordinary.
Channel 6 was confirmed with 176 drone beacons.

---

## Confirmed by live detection — 2026-08-10 20:07

First end-to-end live flight, sensor running on the AWUS036AXML in monitor mode:

| | |
|---|---|
| Frames captured | 473 beacons in ~65 s |
| **Detections** | **222** |
| Dwells | 59 |
| Escalation | fired at +10 s, locking dwell to channel 6 |
| Track | serial `1581F0000000FAKE0001`, 222 history points, confidence 0.6 |
| Flight window | 03:07:51 → 03:08:38 UTC (47 s) |
| Reported altitude | 15 m geodetic |

**The channel-hop escalation works as designed.** One full sweep of 19 channels
(~10 s) found the aircraft on channel 6, after which dwell locked there — which is why
222 of 473 captured beacons were the drone rather than a proportional share.

Notable: the live track carried **no operator position**, while the replayed capture from
earlier the same day did. Consistent with the pre-fix behaviour recorded above — the
controller has no GPS lock for part of the flight, and the System message carries the 0,0
sentinel. Absence of an operator position is normal, not a decode failure.

## DJI proprietary field calibration

**Status: NOT YET PERFORMED**, and possibly not applicable to the Mini 5 Pro — see the open
question above.

Public references disagree on units for several DJI DroneID fields, and DJI has shipped
firmware with differing offsets. The parser in
[`parsers/dji.py`](../../services/sensor-wifi/classg_wifi/parsers/dji.py) ships with
*hypotheses* in `SCALES`. This document is where the measured answers live.

Until this is filled in, treat any DJI altitude, height, velocity, or attitude value as
**unverified**. Position (lat/lon) is the exception — the radian conversion is
well-established and self-evidently right or wrong when you check it against where you're
standing.

## Test article

| | |
|---|---|
| Model | *(e.g. Mini 3 Pro)* |
| Firmware | *(exact version — this record is only valid for this firmware)* |
| Date | |
| Capture | `captures/...` |

## Procedure

Full detail in [test-plan.md](../planning/test-plan.md#layer-2-dji-calibration).

| # | Test | Procedure | Field | Result |
|---|---|---|---|---|
| 1 | Position sanity | Capture on the ground at a known location | `lat`/`lon` | ☐ |
| 2 | Altitude units | Hover at an app-indicated 10 m | `SCALES["height_m"]` | ☐ |
| 3 | Altitude reference | Compare `altitude` vs `height` at known elevation | AMSL vs AGL | ☐ |
| 4 | Velocity units | Fly a straight line at a known speed | `SCALES["velocity_mps"]` | ☐ |
| 5 | Attitude units | Yaw to a known heading | `SCALES["attitude_deg"]` | ☐ |
| 6 | Operator position | Stand well away from the takeoff point | operator vs home fields | ☐ |
| 7 | Beacon interval | Timestamp deltas across a capture | validates ~1 Hz | ☐ |
| 8 | Channel | Note the capture channel | validates ch 6 weighting | ☐ |

## Results

### 1. Position

- Actual location: `lat, lon`
- Decoded: `lat, lon`
- Error: _m_

> A decoded value ~57× too small means the radian→degree conversion was skipped
> (`raw / 174532.925`). A result in the Gulf of Guinea means you're reading zeros —
> the parser should have normalised that to `None`.

### 2. Altitude / height units

- App-indicated height: _m_
- Raw `height` field: _
- **Conclusion:** `SCALES["height_m"] = ___` *(1.0 = metres, 0.1 = decimetres)*

### 3. Altitude reference

- Known ground elevation (AMSL): _m_
- Decoded `altitude` at rest: _
- **Conclusion:** `altitude` is ☐ AMSL ☐ AGL ☐ other

### 4. Velocity units

- Actual ground speed: _m/s_
- Raw `v_north` / `v_east`: _ / _
- **Conclusion:** `SCALES["velocity_mps"] = ___`

### 5. Attitude units

- Actual heading: _°_
- Raw `yaw`: _
- **Conclusion:** `SCALES["attitude_deg"] = ___`

### 6. Operator vs home point

- Takeoff location: `lat, lon`
- Operator standing location: `lat, lon`
- Decoded `operator_lat/lon`: `lat, lon`
- Decoded `home_lat/lon`: `lat, lon`
- **Conclusion:** fields are ☐ correct ☐ swapped

### 7. Beacon interval

- Measured interval: _ ms (n = _ beacons)
- **Conclusion:** the ~1 Hz assumption driving channel dwell is ☐ confirmed ☐ wrong

### 8. Channel

- Observed beacon channel: _
- **Conclusion:** `config/channels.yaml` weighting is ☐ correct ☐ needs revision

---

## Applying the results

1. Update `SCALES` in `parsers/dji.py`, with a comment naming the model and firmware above.
2. Update weights in `config/channels.yaml` if test 8 disagrees with the ch 6 assumption.
3. Add the capture's IEs as test vectors in `services/sensor-wifi/tests/vectors/`.

**Re-run this whole document after any DJI firmware update.** The results are firmware-specific
and there is no way to detect silently that they've gone stale.

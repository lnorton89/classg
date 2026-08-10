# DJI field calibration record

**Status: NOT YET PERFORMED.** Fill this in during Milestone 1.

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

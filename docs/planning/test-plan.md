# Test plan

You have one drone. That is enough to validate a great deal — but only if the captures are
taken deliberately.

## Layer 1 — Parser unit tests (no hardware)

The parsers are pure functions and must be tested exhaustively. This is the highest-value
testing in the project because parser bugs are silent: they produce plausible wrong positions.

**Corpus:** `services/sensor-wifi/tests/vectors/`

| Vector source | Purpose |
|---|---|
| Real DJI captures | Ground truth — the only fully trustworthy vectors |
| `opendroneid-core-c` generated frames | Standards coverage of message types you can't produce |
| Hand-crafted boundary cases | The edges below |

**Boundary cases that must have vectors:**

- Truncated IE (length says 40 bytes, 12 present) → must raise, must not crash
- Length field longer than the frame → bounds check
- Unknown message type nibble → skip cleanly, keep parsing the rest of the pack
- Unknown protocol version → reject loudly rather than misparse
- lat/lon = exactly `0,0` → normalise to `null`, never emit as a position
- Speed multiplier bit transition at the encoding boundary
- Negative vertical speed (int8 sign handling)
- Altitude below the −1000 m offset
- Message Pack claiming more messages than bytes present
- Non-ASCII / non-null-terminated serial fields

**Property test:** any random byte string fed to any parser either returns a valid `Detection`
or raises a defined parser exception. It never crashes the process and never emits a message
that fails schema validation. A drone detector that dies on a malformed beacon is a
denial-of-service target.

---

## Layer 2 — DJI calibration (the one job only your drone can do)

Public documentation disagrees on units for several DJI fields, and firmware varies. Resolve
empirically and record the answers.

| Test | Procedure | Resolves |
|---|---|---|
| **Position sanity** | Capture on the ground at a known location | Radian↔degree conversion (`raw / 174532.925`). A value ~57× off means the conversion was skipped. |
| **Altitude units** | Hover at a DJI-app-indicated 10 m | `height` in m vs dm. Decoding 100 means decimetres. |
| **Altitude reference** | Compare `altitude` vs `height` at a known elevation | AMSL vs AGL |
| **Velocity units** | Fly a straight line at a known speed | cm/s vs dm/s vs m/s |
| **Attitude units** | Yaw to a known heading | degrees vs deci-degrees |
| **Operator position** | Stand well away from the takeoff point | Confirms operator vs home-point fields are not swapped |
| **Beacon interval** | Timestamp deltas across a capture | Validates the ~1 Hz assumption that drives channel dwell |
| **Channel** | Note the capture channel | Validates the ch 6 weighting |

**Deliverable:** `docs/ops/04-calibration.md`, recording drone model, firmware version, date,
and each answer. Encode the results as named constants in the parser with a comment citing
that document. Firmware updates invalidate this — re-run after any DJI firmware update.

---

## Layer 3 — Sensor integration (hardware, no flying)

- Monitor mode survives 1 hour without wedging
- Channel hopper hits configured dwell ratios within ±10%
- Sensor emits heartbeats when nothing is detected
- **Unplug the adapter mid-run** → sensor exits non-zero, systemd restarts, fusion marks the
  source stale within 30 s
- Replug → sensor recovers without manual intervention
- Both radios running simultaneously for 1 hour with no USB brownout
- ZMQ HWM: flood the bus with synthetic detections, confirm drops are counted and the capture
  loop never blocks

---

## Layer 4 — End-to-end flight tests

### T1 — Static detection
Drone powered on, on the ground, 10 m away.
**Pass:** track appears within 5 s, `state=CONFIRMED` within 15 s, serial matches the sticker.

### T2 — Track continuity
Hover at 30 m for 5 minutes.
**Pass:** one continuous track. **No track splits.** Track splitting under channel hopping is
the most likely failure and the main thing this test exists to catch.

### T3 — Range walk
Fly directly away in a straight line to the limit of your comfort and legal VLOS.
**Pass:** record RSSI vs. reported GPS distance. Produces the range curve and shows where
detection degrades. **This is the single most informative test in the plan** — it tells you
what the system's real coverage is.

### T4 — Channel-hop stress
Fly while the hopper runs its full weighted plan.
**Pass:** measure detections/second vs. the T2 baseline (which can use a locked channel). The
delta *is* the cost of hopping — the number that justifies the tuning work.

### T5 — Occlusion
Fly behind a building.
**Pass:** track enters `COASTING`, then recovers to the **same track ID** when line-of-sight
returns. Validates that coast timeouts are set sensibly.

### T6 — Restart resilience
Kill `fusion` mid-flight.
**Pass:** restarts, rebuilds tracks from live detections within 30 s. Track IDs will change —
that is intended, per the decision not to persist track state.

### T7 — Negative control
Run for 1 hour with the drone powered **off**, in a normal Wi-Fi environment.
**Pass:** **zero** Class A/B detections. Any Class C (OUI) hits are logged with confidence
≤ 0.10 and never produce a `CONFIRMED` track.

T7 matters more than it looks. A detector that finds drones everywhere is useless, and the
false-positive rate is what most projects in this space never measure.

---

## Layer 5 — SDR validation (Milestone 3, needs hardware you lack)

**Blocked:** validating Class E control-link detection requires an ELRS/Crossfire transmitter.
Without one, the detector cannot be shown to work — and an unvalidated detector is worse than
no detector, because it produces confident output nobody has checked.

Options: borrow an FPV setup, buy an ELRS module (~$25), or defer Milestone 3.

Achievable without extra hardware:
- ADS-B decode validated against [adsb.lol](https://adsb.lol) / FlightRadar24 for the same aircraft
- Noise-floor measurement and threshold stability over 24 h
- Sweep timing: full 902–928 MHz sweep completes within the configured budget
- **Negative control:** 24 h with no drone activity → count Class E/F false positives per hour.
  Set the threshold from this measurement rather than from a guess.

---

## Continuous checks (CI)

- All parser unit tests and property tests
- Every emitted message validates against `schemas/*.schema.json` — in all four languages
- Replay the capture corpus end to end; assert detection counts match a recorded baseline
- Lint/format: `ruff` + `mypy`, `go vet` + `staticcheck`, `clippy`, `eslint`

Corpus replay is the regression net. Once real captures exist, any parser change that alters
detection counts on known-good data fails the build.

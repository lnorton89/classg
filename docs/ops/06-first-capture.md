# First capture — runbook

Milestone 0's exit criterion: a PCAP containing verified drone beacons, plus a written
record of the drone's model, firmware, channel, and beacon interval.

---

## Two minutes with a phone, before anything else

**Does your drone broadcast Remote ID over Wi-Fi at all?** Some models and firmware are
Bluetooth-only, and no amount of Wi-Fi capture work will ever see one of those. Install
[OpenDroneID receiver](https://github.com/opendroneid/receiver-android) on an Android phone,
power the drone, look.

It is not a PCAP, so it does not satisfy Milestone 0 by itself. But it is the one answer worth
having before you spend a battery on a capture: if the drone turns out to be Bluetooth-only,
the path forward is the nRF52840 dongle from Milestone 4 instead.

---

## Where the capture runs

The Pi. Its kernel has `mt7921u` in-tree since 5.18, so the ALFA is an ordinary USB device
with a driver already present — plug it in and the interface appears. If the unit is not
brought up yet, [01-pi-setup.md](01-pi-setup.md) →
[02-wifi-adapter.md](02-wifi-adapter.md) come first; there are real MT7921AU landmines there.

---

## The capture

### 1. Preflight — before the drone is airborne

```bash
./scripts/check-capture-env.sh wlan-alfa
```

Every check prints PASS/FAIL/WARN and it exits non-zero on anything blocking. Fix all failures
before flying — diagnosing an adapter problem with a drone hovering is a waste of battery. It
separates *driver missing* from *driver present but not loaded* from *loaded but probe
failed*, because those three look identical from the absence of a `wlan` interface and have
nothing in common as fixes.

### 2. Capture

```bash
sudo ./scripts/first-capture.sh wlan-alfa 6 120
```

This locks to **one channel** deliberately. With hopping enabled, an empty capture cannot
distinguish "the drone is silent" from "we were listening elsewhere". It also verifies beacons
from *any* network arrive before recording, so a dead adapter fails fast with a clear message
rather than producing an empty file.

Power on the drone → let it acquire GPS → hover → land.

**If nothing is found on channel 6:**

```bash
sudo ./scripts/first-capture.sh wlan-alfa sweep
```

Walks all 13 channels looking for OUI `26:37:12` and `fa:0b:bc`, then tells you which channel
to re-run on.

### 3. Analyse

```bash
cd services/sensor-wifi
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[replay]'
.venv/bin/python -m classg_wifi.cli analyze ../../captures/<file>.pcap
```

This runs the capture through the project's own parsers and reports:

- **Channel** the drone actually used → evidence for `config/channels.yaml` weights
- **Beacon interval**, with a warning if the ~1 Hz design assumption is wrong → dwell budget
- **Decoded Remote ID and DJI DroneID** — serial, position, operator location
- **A CALIBRATION table** showing each DJI field's *raw* integer next to its decoded value

The calibration table is the point. Public references disagree on DJI's units and firmware
varies, so the parser ships hypotheses. Compare each raw value against what the DJI app showed
and record the answers in [04-calibration.md](04-calibration.md).

The tool is already tested end-to-end against synthetic captures
(`tests/test_analyze.py`, `tests/test_dot11.py`), so if it reports nothing, the capture is
genuinely empty rather than the tool being broken.

### 4. Record

Fill in [04-calibration.md](04-calibration.md), then commit the extracted IEs as test vectors
in `services/sensor-wifi/tests/vectors/`. **Do not commit the PCAP** — it contains every
network in range, not just the drone.

---

## While you are out there

Two captures are worth more than one:

| Capture | Why |
|---|---|
| **First flight** | Ground truth for every parser offset and calibration constant |
| **Negative control** — 1 hour, drone powered **off** | Measures the false-positive rate. Most projects in this space never do this, which is why they quote detection rates nobody has verified. |

Note the exact **firmware version** from the DJI app. Field offsets move between firmware
revisions, so a capture is only meaningful alongside the firmware that produced it.

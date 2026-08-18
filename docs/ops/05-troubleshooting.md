# Troubleshooting

## Diagnose in this order

Most time lost on this project goes to debugging a parser when the real problem was three
layers down. Work bottom-up:

```
1. Is the device enumerated?        lsusb, dmesg
2. Is the driver bound?             dmesg | grep -i mt7921 / rtl
3. Is the interface in the right mode?   iw dev wlan1 info
4. Are frames arriving at all?      tcpdump -c 20
5. Are drone IEs present?           wireshark: wlan.tag.number == 221
6. Is the parser decoding them?     classg-sensor-wifi replay
7. Is fusion receiving?             heartbeat + detection counters
```

Never skip step 4. If `tcpdump` shows nothing, the parser is irrelevant.

---

## "Nothing is being detected"

**First: is the drone actually broadcasting?** Not every DJI model broadcasts Wi-Fi Remote ID,
and firmware matters. Confirm with a phone app (OpenDroneID receiver on Android) before
assuming your stack is broken.

| Check | Command |
|---|---|
| Frames arriving | `sudo tcpdump -i wlan1 -c 20 -e "type mgt subtype beacon"` |
| On the right channel | `iw dev wlan1 info` — is it parked where the drone beacons? |
| Interference taken the interface | `sudo airmon-ng check kill` |
| Power management dropping frames | `iw dev wlan1 set power_save off` |

**Channel is the most common cause.** With weighted hopping the sensor is only on any given
channel a fraction of the time. For debugging, **lock to one channel** and confirm detection
works there before re-enabling hopping.

---

## "One drone showed up as two tracks"

Usually correct, and usually not a fusion bug. A DJI presents more than one radio: the Remote
ID beacon on 2.4 GHz and a 5.8 GHz access point are different MACs, and fusion links two
identities only when a *single detection* carries both. Two MACs that never share a frame are
two tracks by construction.

Check what the sensor actually saw before assuming a correlation failure:

```bash
sudo sqlite3 /var/lib/docker/volumes/classg-data/_data/classg.db "SELECT mac, detection_class, COUNT(*), MIN(ts), MAX(ts) FROM detections WHERE mac != '' GROUP BY mac, detection_class ORDER BY MIN(ts);"
```

| What you see | Reading |
|---|---|
| Two MACs, different channels, **non-overlapping** time ranges | Two radios on one airframe. Expected. |
| One track class A/B, the other class C only | The class C one is a vendor guess — it belongs under **Unidentified RF**, not in the aircraft count |
| Same MAC, two track IDs | A real bug. The first track closed and a new one was minted; check `CloseAfter` against the gap |
| Two MACs seen **simultaneously**, both class A, different serials | Two aircraft |

Look up an OUI before trusting the vendor label — `data/ieee-oui.csv` is in the sensor tree.
`8c:1e:d9` is Beijing Unigroup Tsingteng, a chipset vendor, and the DJI rule in
`oui_fingerprints.yaml` claims it anyway, so *every* device on that silicon reads as DJI.

**A gap in the 5 GHz record during a flight is expected on older builds.** Escalation used to
lock the radio to the tracked channel absolutely, so nothing else was sampled for as long as
the drone kept transmitting. `--escalation-scan-every` (default 4) now reserves a share of
dwells for the sweep; `scan_dwells` in the hopper's efficiency report should climb alongside
`escalations`.

---

## "Detections appear, then stop"

| Symptom | Cause | Fix |
|---|---|---|
| Stops after minutes, interface still up | mt7921u wedged | Replug. Confirm you're not setting *active* monitor anywhere. |
| Stops when the SDR is running | USB power brownout | `dmesg \| grep -i "usb.*reset"`. Powered hub or better PSU. |
| Stops after a NetworkManager event | Interface reclaimed | `nmcli device set wlan1 managed no` |
| Gradual degradation | Thermal throttling | `vcgencmd measure_temp` |

---

## "Positions look wrong"

| Symptom | Cause |
|---|---|
| Position ~57× too small | Radian→degree conversion skipped (`raw / 174532.925`) |
| Everything at 0°N 0°E | Reading zeros — should be normalised to `null`, not emitted |
| Altitude off by 10× | Metres vs decimetres — run [calibration](04-calibration.md) |
| Altitude off by exactly 1000 m | The `-1000` offset applied twice, or not at all |
| Position jumps wildly | Two aircraft merged into one track — check MAC randomisation |

Altitude and velocity are **unverified until [04-calibration.md](04-calibration.md) is
filled in.** Don't debug those against an assumption; measure them against the drone.

---

## "Timestamps or uptime look wrong"

| Symptom | Cause |
|---|---|
| `uptime_s` far larger than the process has been alive | Fixed — elapsed time was wall-clock arithmetic that counted the boot NTP correction |
| Detections stamped hours before they happened | Emitted during the window between boot and the first NTP sync |
| Timestamps in 1969/1970 | Clock never set at all — no RTC, no network, `fake-hwclock` data missing |
| Every sensor briefly `stale` at once, then recovers | The clock jumped forward; heartbeats stamped before it look old for one interval |

**A Pi has no RTC.** `timedatectl` reports `RTC time: n/a`. It boots with
whatever `fake-hwclock` saved at last shutdown, systemd starts the sensors
against that wrong clock, and `systemd-timesyncd` only corrects it once the
network is up and a time server answers. Measured on the unit on 2026-08-17:
boot at 09:51:12, sensors started, then

```
09:52:03 systemd-timesyncd[529]: Initial clock synchronization to Mon 2026-08-17 09:52:03 PDT
```

a jump of **7 h 51 min**, about fifty seconds after boot. Anything stamped in
that window carries the stale time permanently.

```bash
timedatectl                                  # NTPSynchronized, and whether an RTC exists at all
journalctl -b | grep -iE "clock|synchroniz"  # the jump, with its size and when it landed
```

The field case is the one that matters. A unit deployed with no uplink never
reaches a time server, so the correction never arrives and a wrong absolute
clock is the steady state rather than a first-minute transient.

Detections carry the wall clock, not a monotonic reading: `_now_iso()` in
`detection.py` and `epoch_ms()` in `clock.rs` both read the system clock, and
the detection ULID embeds it as its sortable prefix. A correction moves the
record with it — the forward jump at boot leaves a fictitious multi-hour gap
between the first detections and everything after, and ULID ordering survives
only because the jump happens to go forward. If you need correct absolute
timestamps in the field, fit an RTC module; no amount of software fixes a clock
with nothing to read.

---

## "Too many detections / false positives"

Check the **detection class** first. Class C (OUI/SSID fingerprint) is expected to produce
occasional false positives and is capped at 0.10 confidence for exactly that reason — a
Class C hit is not a detection, it's a hint.

If Class A or B are firing on non-drones, that's a real bug: those require a valid vendor IE
with a valid structure. Capture the frame and add it as a test vector.

Run the **T7 negative control** (1 hour, drone powered off) to get a measured false-positive
rate rather than an impression.

---

## "The SDR sees nothing at 2.4 GHz"

Working as designed. The RTL-SDR V4 tunes to **1.766 GHz maximum**. It cannot receive
2.4 GHz or 5.8 GHz at any gain, with any antenna, ever.

Your DJI is detected by the **Wi-Fi adapter**, not the SDR. See
[ADR-0004](../architecture/adr/0004-rtlsdr-scope.md).

---

## "The RTL-SDR produces noise or wrong frequencies"

Almost always the driver. The V4 requires the **RTL-SDR Blog fork** — stock `librtlsdr`
doesn't support the R828D configuration. See [03-sdr-setup.md](03-sdr-setup.md).

```bash
sudo apt purge rtl-sdr librtlsdr0 librtlsdr-dev   # then build the fork
```

---

## Useful one-liners

```bash
# What's on this interface right now
sudo tcpdump -i wlan1 -e -c 50 "type mgt subtype beacon" | awk '{print $NF}' | sort | uniq -c

# Watch USB resets in real time
dmesg -w | grep -i usb

# Confirm both radios are present
lsusb | grep -Ei "0e8d|0bda"

# Exercise the pipeline with no hardware
cd services/sensor-wifi
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[replay]'
.venv/bin/python -m classg_wifi.cli replay ../../captures/dji-first-flight.pcap
```

## Before filing a bug against your own code

1. Does `tcpdump` show beacons? → if no, hardware/mode problem
2. Does Wireshark show tag 221 with OUI `26:37:12` or `fa:0b:bc`? → if no, the drone isn't broadcasting
3. Does `replay` on that PCAP produce detections? → if no, **now** it's a parser bug, and you have a reproducible test case

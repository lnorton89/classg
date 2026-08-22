# ALFA + TP-Link Wi-Fi receiver setup

ClassG uses two independent passive receivers on the Pi:

- `wifi-0` / `wlan-alfa` — ALFA AWUS036AXML, weighted hard toward the Mini 5
  Pro's measured channel 6 (`config/channels-primary.yaml`).
- `wifi-1` / `wlan-tplink` — TP-Link Archer TX20U Plus, sweeping the remaining
  2.4 and 5 GHz plan (`config/channels-sweep.yaml`).

`wifi-0` is *weighted*, not parked. Parked was the first version and it logged
0 frames across 116,788 dwells here, because nothing else transmits on channel 6
at this site — indistinguishable from a dead antenna. The weights keep channel 6
at ~83% of dwells and spend the rest on 1 and 11 for proof of life.

The stable names come from `deploy/udev/70-classg-wifi.rules`; never key a
service to `wlan1` or `wlan2`, because probe order changes after a USB reset.

## One adapter, or one that went missing

The two plans partition the spectrum, so **neither is safe on its own**:
`channels-primary.yaml` has no 5 GHz at all, and `channels-sweep.yaml` has no
channel 6 at all — the one channel a DJI was actually measured on here.

Both units therefore pass `--solo-channels config/channels.yaml` and
`--companion-iface <the other radio>`. At startup each receiver waits up to
`--companion-wait-s` (15 s, covering the udev race and the TP-Link's USB
mode-switch) for the other interface to appear, and widens to the full plan if
it never does. A single-adapter build needs no configuration for this; it just
works, and `systemctl status` shows which plan was loaded.

Two limits worth knowing:

- **The choice is made once, at startup.** An adapter unplugged mid-run does not
  re-widen the survivor — swapping plans means rebuilding the hopper's weights
  under a live capture loop, and restarting to reload them drops frames during
  exactly the event you care about. `/health` reports the state instead.
- **Presence of the interface is the signal, not the unit.** Plug the TP-Link in
  without enabling `classg-sensor-wifi-tplink.service` and the primary stays on
  the split plan while nothing sweeps. Declaring both radios in
  `CLASSG_EXPECTED_SENSORS` is what catches that — see
  [00-configuration.md](00-configuration.md).

## Tuning the two radios separately

They are not the same radio and should not be assumed to want the same dwell.
The ALFA is mt7921u covering 3 channels; the TP-Link is rtl8852au behind a
vendor driver covering 16, including 5 GHz.

Each receiver now measures its own retune cost and reports it on the heartbeat,
so this is an observation rather than a guess:

| Heartbeat field | What |
|---|---|
| `hop_latency_ms` | what a retune actually costs this receiver, averaged over timed hops |
| `hop_latency_measured` | `false` only before the first hop, when the estimate is still in use |
| `listening_fraction` | share of wall-clock spent receiving rather than retuning |
| `hop_overhead_ms` | total blind time spent retuning |

`hop_latency_ms` was a hardcoded 140 until this was wired up — a figure measured
on the ALFA and applied to both, which made the TP-Link's `listening_fraction`
a number about the wrong chipset.

Read both radios' figures off the Sensors page, then tune each unit's
`ExecStart` independently — the flags override the shared `.env`, which is the
only way to give two receivers different values from one file:

```
--dwell-ms 400              # raise if listening_fraction is below ~0.6
--escalation-scan-every 4   # lower on the sweep receiver to give up less of a
                            # 16-channel plan while locked to one channel
```

Neither default has been re-derived from a measured rtl8852au hop cost. Take the
numbers off a real unit before changing them.

## Pi 4 USB layout and power

Prefer both Wi-Fi adapters in the blue USB 3 ports and the USB 2 RTL-SDR in a
regular port, but validate the SDR before making that permanent. All ports
still share the Pi's USB power budget; port colour does not solve an overloaded
supply. The field unit has three nominally bus-powered receivers, so a powered
hub is the correct answer if resets appear under simultaneous capture. Keep the
Wi-Fi antennas on short extension leads away from the Pi and USB 3 connectors
to reduce 2.4 GHz interference.

After any port change, run `scripts/usb-soak.sh` and watch both USB presence and
the per-sensor beacon counters. Enumeration alone does not prove that a radio
is delivering frames.

**Read this before plugging the adapter in.** There are two ways to make this device stop
working that are easy to trigger and annoying to diagnose.

## The two landmines

### 1. Never set active monitor mode

```bash
sudo iw dev wlan-alfa set monitor active # ← DO NOT. Wedges the driver.
```

Active monitor on `mt7921u` is a known driver bug that stops the adapter dead, usually
requiring a physical replug.
([mt76 #839](https://github.com/openwrt/mt76/issues/839),
[USB-WiFi #275](https://github.com/morrownr/USB-WiFi/issues/275))

Passive monitor is all ClassG needs — we only receive.

### 2. Disable the adapter's Bluetooth

On kernels 6.6+, the MT7921's Bluetooth sharing the USB device with `mt7921u` causes sporadic
Wi-Fi crashes. Wi-Fi is the primary mission, so give it the whole device:

```bash
echo 'install btusb /bin/false' | sudo tee /etc/modprobe.d/classg-no-btusb.conf
sudo reboot
```

Use a **separate** nRF52840 dongle for Bluetooth Remote ID (Milestone 4). Do not try to make
one device do both.

---

## Setup

### Verify kernel and firmware

`mt7921u` is in-kernel since **Linux 5.18**:

```bash
uname -r
```

Install firmware blobs if missing:

```bash
sudo apt update && sudo apt install -y firmware-misc-nonfree
```

Plug in and confirm:

```bash
dmesg | grep -i mt7921
lsusb | grep -i 0e8d
iw dev
```

You want `mt7921u` bound and firmware loaded. If the driver loads but the adapter never
initialises, firmware blobs are missing — that is the usual cause.

### TP-Link driver survival across kernel updates

The Archer TX20U Plus (`2357:013f`) uses the out-of-tree `rtl8852au` driver.
It must be registered with DKMS, not merely copied into the current kernel's
module directory. Verify this after installation and after every kernel update:

```bash
dkms status | grep rtl8852au
modinfo 8852au | grep -E '^(filename|version|vermagic):'
```

`dkms status` must list the running `uname -r` as `installed`. ClassG's setup
script fails with an actionable error if `8852au` is absent; it does not try to
compile a kernel module while starting a field service.

### Enter monitor mode

```bash
sudo airmon-ng check kill                # stop NetworkManager/wpa_supplicant interference
sudo ip link set wlan-alfa down
sudo iw dev wlan-alfa set type monitor   # passive — no 'active'
sudo ip link set wlan-alfa up
sudo iw dev wlan-alfa set channel 6

sudo ip link set wlan-tplink down
sudo iw dev wlan-tplink set type monitor
sudo ip link set wlan-tplink up
sudo iw dev wlan-tplink set channel 1
```

Verify:

```bash
iw dev wlan-alfa info     # expect: type monitor, channel 6 (2437 MHz)
iw dev wlan-tplink info  # expect: type monitor
```

### Persist across reboots

`scripts/setup-monitor.sh` handles this idempotently. The shipped systemd unit
([deploy/systemd](../../deploy/systemd), installed per [09-deployment.md](09-deployment.md))
already runs it as `ExecStartPre=`, so monitor mode is re-established on every start —
it survives neither a reboot nor a replug, and moving the adapter between USB ports
silently drops the interface back to managed.

---

## First capture — do this before writing any code

Capture your DJI powering up. This is Milestone 0's exit criterion and the ground truth
everything else is built against.

```bash
sudo tcpdump -i wlan-alfa -w captures/dji-first-flight.pcap "type mgt subtype beacon"
```

Power on the drone, let it acquire GPS, hover briefly, land. Then inspect in Wireshark:

- Filter `wlan.tag.number == 221` for vendor-specific IEs
- Look for OUI `26:37:12` (DJI DroneID) and `fa:0b:bc` (ASTM F3411 Remote ID)
- **Record the channel** the drone actually beacons on
- **Record the beacon interval** — validates the ~1 Hz assumption driving channel dwell

Write these into `docs/ops/04-calibration.md`.

---

## Channel behaviour

```bash
sudo iw dev wlan-alfa set channel 6      # 2.4 GHz
sudo iw dev wlan-tplink set freq 5180    # 5 GHz by frequency
```

Measured channel-hop latency on this chipset is around **140 ms**, which is a meaningful
fraction of the 1 s beacon interval and is exactly why weighted dwell matters. Factor hop
latency into the dwell budget — a 250 ms dwell is really ~110 ms of listening.

### 6 GHz — ignore it

The US regulatory database sets `NO-IR` for 6 GHz, which disables passive listening. Drones do
not broadcast Remote ID there. Not worth the regdb fight.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Adapter enumerates, never initialises | Missing firmware | `apt install firmware-misc-nonfree` |
| Monitor mode set, zero frames | NetworkManager took the interface | `airmon-ng check kill` |
| Adapter dead after a mode change | Active monitor was set | Physical replug; never set active again |
| Random disappearance under load | USB power brownout | Powered hub, or better PSU; check `dmesg` for USB resets |
| Sporadic Wi-Fi crashes | BT/Wi-Fi USB conflict | Disable `btusb` as above |
| Works alone, fails with the SDR plugged in | USB bandwidth/power contention | Separate USB controllers (Pi 5), or powered hub |
| TP-Link enumerates but its LED stays dark | Interface is down/idle | Confirm `2357:013f`, then start its monitor service |
| TP-Link first appears as `0bda:1a2b` | USB storage mode before mode-switch | Wait for udev/usb-modeswitch to expose `2357:013f` |
| Driver vanishes after a kernel update | Module was copied, not DKMS-built | Check `dkms status`; rebuild `rtl8852au` for `uname -r` |
| No 6 GHz channels | `NO-IR` in regdb | Expected. Ignore. |

## Sanity check before blaming your code

```bash
sudo tcpdump -i wlan-alfa -c 20 -e "type mgt subtype beacon"
sudo tcpdump -i wlan-tplink -c 20 -e "type mgt subtype beacon"
```

If this shows nothing, the problem is the adapter or monitor mode — not the parser. Always
establish that frames are arriving before debugging decode logic.

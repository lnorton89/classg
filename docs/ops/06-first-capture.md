# First capture — runbook

Milestone 0's exit criterion: a PCAP containing verified drone beacons, plus a written
record of the drone's model, firmware, channel, and beacon interval.

---

## ⚠️ WSL2 cannot do this as-is

Measured on this machine, 2026-08-10:

| Check | Result |
|---|---|
| Distro | Debian 13 (trixie), WSL2 |
| Kernel | `6.18.33.2-microsoft-standard-WSL2` |
| `cfg80211` | ✅ present (module) |
| `mac80211` | ✅ present (module) |
| **`mt7921u` / `mt76` / `mt76_usb`** | ❌ **ABSENT** |
| Wireless drivers actually built | only `iwlwifi`, `iwlmvm`, `rsi_*` |
| `vhci_hcd` (usbip client) | ✅ present |
| `usbipd-win` | ✅ installed; adapter visible at busid `2-9` (`0e8d:7961`) |
| `tcpdump`, `usbip` in WSL | ❌ missing |

**The conclusion:** USB forwarding would work, but there is no MediaTek driver in the WSL
kernel for the adapter to bind to. No driver → no `wlan` interface → no monitor mode → no
capture. This is not a configuration problem; the module was never built.

The commonly repeated "WSL has no wireless support at all" is now outdated — kernel 6.18 does
ship `cfg80211`/`mac80211`. But the mt76 driver family specifically is not included.

### Options, best first

**1. Raspberry Pi — the target platform.** Highest fidelity: it is where this will actually
run, its kernel has `mt7921u` in-tree since 5.18, and it avoids usbip entirely. If the Pi is
ready, use it. Follow [01-pi-setup.md](01-pi-setup.md) → [02-wifi-adapter.md](02-wifi-adapter.md).

**2. Live USB (Kali or Ubuntu).** Boot this same machine from a USB stick. Native driver,
native USB, no kernel build, no forwarding layer. ~15 minutes to write the stick. The most
reliable way to get a capture *today* without the Pi.

**3. Custom WSL2 kernel.** Buildable here — 16 cores and 930 GB free make it a ~20–30 minute
job. Steps below. **Caveat worth weighing:** monitor mode over usbip adds an unproven layer.
The USB bulk transfers that carry captured frames are being tunnelled over TCP into a VM, and
I could find no confirmation that mt7921u monitor mode works reliably through that path. It
may work fine; it may drop frames in ways that look like drone-side problems. For the *first*
capture, where you need to trust a negative result, that ambiguity is expensive.

**4. Android phone + OpenDroneID receiver.** Not a PCAP, so it does not satisfy Milestone 0 —
but it takes two minutes and answers the single most important question before you invest in
any of the above: **does your drone broadcast Remote ID over Wi-Fi at all?** Some models and
firmware are Bluetooth-only. Install
[OpenDroneID receiver](https://github.com/opendroneid/receiver-android), power the drone, look.

> **Do #4 first regardless of which capture path you choose.** If the drone turns out to be
> Bluetooth-only, then no amount of Wi-Fi capture work will ever see it, and the answer is the
> nRF52840 dongle from Milestone 4 instead.

### Building a WSL2 kernel with mt76 (option 3)

```bash
sudo apt update && sudo apt install -y build-essential flex bison libssl-dev libelf-dev \
  bc dwarves python3 pahole git tcpdump iw usbutils linux-tools-generic firmware-misc-nonfree
git clone --depth 1 --branch linux-msft-wsl-6.6.y \
  https://github.com/microsoft/WSL2-Linux-Kernel.git ~/WSL2-Linux-Kernel
cd ~/WSL2-Linux-Kernel
cp Microsoft/config-wsl .config
```

Enable the MediaTek USB driver and monitor-mode support:

```bash
scripts/config --enable  CONFIG_CFG80211
scripts/config --enable  CONFIG_MAC80211
scripts/config --enable  CONFIG_WLAN_VENDOR_MEDIATEK
scripts/config --module  CONFIG_MT7921U
scripts/config --module  CONFIG_MT7921_COMMON
scripts/config --module  CONFIG_MT76_USB
scripts/config --module  CONFIG_MT76_CONNAC_LIB
scripts/config --enable  CONFIG_USBIP_CORE
scripts/config --module  CONFIG_USBIP_VHCI_HCD
make olddefconfig
make -j"$(nproc)" && sudo make modules_install
cp arch/x86/boot/bzImage /mnt/c/Users/Lawrence/wsl-kernel-classg
```

Then add to `C:\Users\Lawrence\.wslconfig` under the existing `[wsl2]` section:

```ini
kernel=C:\\Users\\Lawrence\\wsl-kernel-classg
```

`wsl --shutdown`, reopen, then forward the adapter **from an Administrator PowerShell**:

```powershell
usbipd bind --busid 2-9
usbipd attach --wsl --busid 2-9
```

Verify with `./scripts/check-capture-env.sh` before going further.

> Your `.wslconfig` currently sets `vmIdleTimeout=-1`, `processors=16`, `memory=16GB`. Adding
> a `kernel=` line does not disturb those, but it applies to **every** distro including Docker
> Desktop's — if Docker misbehaves afterwards, that is the cause. Remove the line to revert.

---

## The capture, once you have a working Linux

Everything below is the same on the Pi, a live USB, or a fixed WSL.

### 1. Preflight — before the drone is airborne

```bash
./scripts/check-capture-env.sh wlan1
```

Every check prints PASS/FAIL/WARN and it exits non-zero on anything blocking. Fix all failures
before flying — diagnosing an adapter problem with a drone hovering is a waste of battery.

### 2. Capture

```bash
sudo ./scripts/first-capture.sh wlan1 6 120
```

This locks to **one channel** deliberately. With hopping enabled, an empty capture cannot
distinguish "the drone is silent" from "we were listening elsewhere". It also verifies beacons
from *any* network arrive before recording, so a dead adapter fails fast with a clear message
rather than producing an empty file.

Power on the drone → let it acquire GPS → hover → land.

**If nothing is found on channel 6:**

```bash
sudo ./scripts/first-capture.sh wlan1 sweep
```

Walks all 13 channels looking for OUI `26:37:12` and `fa:0b:bc`, then tells you which channel
to re-run on.

### 3. Analyse

```bash
cd services/sensor-wifi
python -m classg_wifi.cli analyze ../../captures/<file>.pcap
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

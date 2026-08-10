# First capture — runbook

Milestone 0's exit criterion: a PCAP containing verified drone beacons, plus a written
record of the drone's model, firmware, channel, and beacon interval.

---

## WSL2 status: working with the custom kernel

Initial stock-kernel baseline measured on this machine, 2026-08-10:

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

**Final result on the same date:** the 6.18.33.2 custom kernel works with this adapter at
USB 2 high speed (480 Mbit/s). The two required MT7961 Wi-Fi blobs must be compiled into the
kernel image: WSL's shared kernel can otherwise resolve firmware from an initial mount
namespace where Debian's `/lib/firmware` is not visible. With embedded firmware, `mt7921u`
reports its WM firmware version and registers `phy0` / `wlan0` without usbip URB errors.

The commonly repeated "WSL has no wireless support at all" is now outdated — kernel 6.18 does
ship `cfg80211`/`mac80211`. But the mt76 driver family specifically is not included.

### Options, best first

**1. Raspberry Pi — the target platform.** Highest fidelity: it is where this will actually
run, its kernel has `mt7921u` in-tree since 5.18, and it avoids usbip entirely. If the Pi is
ready, use it. Follow [01-pi-setup.md](01-pi-setup.md) → [02-wifi-adapter.md](02-wifi-adapter.md).

**2. Live USB (Kali or Ubuntu).** Boot this same machine from a USB stick. Native driver,
native USB, no kernel build, no forwarding layer. ~15 minutes to write the stick. The most
reliable way to get a capture *today* without the Pi.

**3. Custom WSL2 kernel — possible, but a coin flip on this specific chipset.** See
[the WSL section below](#can-it-work-in-wsl-yes-with-one-real-risk) for the evidence and the
automated build script.

**4. Android phone + OpenDroneID receiver.** Not a PCAP, so it does not satisfy Milestone 0 —
but it takes two minutes and answers the single most important question before you invest in
any of the above: **does your drone broadcast Remote ID over Wi-Fi at all?** Some models and
firmware are Bluetooth-only. Install
[OpenDroneID receiver](https://github.com/opendroneid/receiver-android), power the drone, look.

> **Do #4 first regardless of which capture path you choose.** If the drone turns out to be
> Bluetooth-only, then no amount of Wi-Fi capture work will ever see it, and the answer is the
> nRF52840 dongle from Milestone 4 instead.

---

## Can it work in WSL? Yes — with one real risk

### Why a kernel rebuild is unavoidable

| Probe | Result |
|---|---|
| `CONFIG_MT7921U` in the running kernel | `# CONFIG_MT7921U is not set` — **explicitly disabled** |
| `/lib/modules/$(uname -r)/build` | **absent** → cannot build the driver out-of-tree |
| `CONFIG_MODULE_SIG_FORCE` | not set → self-built modules will load fine |
| MT7961 firmware in `/lib/firmware/mediatek` | **absent** → must be installed |

There is no shortcut. Replacing the kernel is the only route.

### The technique is proven — just not on this chipset

Monitor mode in WSL2 over `usbipd` genuinely works. There are working write-ups for
**Atheros AR9271** ([wsl2-ar9271-monitor](https://github.com/BicycleJunkie1971/wsl2-ar9271-monitor))
and **Realtek RTL8812AU** ([wsl2-wifi-adapter-setup](https://github.com/akulihin/wsl2-wifi-adapter-setup)),
both including injection. So the architecture — custom kernel, usbip forwarding, `mac80211`
monitor mode — is not the problem.

**The problem is MediaTek specifically.**
[microsoft/WSL#12288](https://github.com/microsoft/WSL/issues/12288) reports USB ID
`0e8d:7961` — byte-for-byte the AWUS036AXML — attached over `usbipd` to a custom WSL2 kernel,
**crashing the entire WSL VM during `mt7921u` initialisation**. The log ends at
`WM Firmware Version:` and the session drops back to PowerShell, so firmware loads and the
crash comes at driver probe. Reported on kernels 6.1 and 6.6. Closed unresolved, no
workaround, no community reply.

### Why it might still work for you

That report is against 6.1/6.6. This build targets **6.18.33.2**, matching your running
kernel — many `mt7921u` fixes newer than the failure. Nobody has published a confirmed
success on this chipset, and nobody has published a confirmed failure on 6.18 either. It is
genuinely untested territory.

Realistic odds: a coin flip, for ~30 minutes of build time, with a clean bail-out.

### Doing it

```bash
./scripts/wsl-build-kernel.sh
```

Handles dependencies, firmware blobs, source checkout at the matching tag, config, build, and
module install, then prints the Windows-side steps. It verifies `CONFIG_MT7921U` actually
stuck before spending 30 minutes compiling.

Everything up to the `usbipd attach` is **safe and reversible**. The moment of truth is the
attach:

```powershell
usbipd bind   --busid 2-9
usbipd attach --wsl --busid 2-9
```

- **WSL survives and `iw dev` shows an interface** → you win, carry on to the capture.
- **WSL dies instantly** → that is #12288. No known fix. Switch to the Pi or a live USB.

### Then load the driver — WSL will not do it for you

**Confirmed 2026-08-10:** the custom kernel worked, WSL survived the attach (no #12288 crash),
the adapter enumerated as `Bus 002 Device 002: ID 0e8d:7961`, and firmware was in place — but
**no wireless interface appeared, because no module was loaded**.

WSL does not run udev the way a normal distro does, so a usbip-attached device never triggers
module autoloading. The driver just sits on disk, unloaded.

```bash
sudo modprobe mt7921u
```

The build script embeds `WIFI_MT7961_patch_mcu_1_2_hdr.bin` and
`WIFI_RAM_CODE_MT7961_1.bin` in the kernel. Seeing those same files under Debian's
`/lib/firmware` is not sufficient on WSL when the kernel's initial mount namespace belongs
to another system distro such as Docker Desktop.

`scripts/setup-monitor.sh` and `scripts/first-capture.sh` now do this automatically, and
`check-capture-env.sh` distinguishes *driver missing* from *driver present but not loaded*
from *loaded but probe failed*.

To make it stick across restarts:

```bash
echo mt7921u | sudo tee /etc/modules-load.d/classg.conf
```

Then:

```bash
./scripts/check-capture-env.sh
```

> **Two notes.** Adding `kernel=` to `.wslconfig` applies to **every** distro, Docker
> Desktop's included — remove the line to revert. And attaching the adapter removes it from
> Windows for the duration; your Intel PCI card keeps Windows online.

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

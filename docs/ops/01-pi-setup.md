# Raspberry Pi setup

## Hardware recommendation

**Pi 5 strongly preferred over Pi 4.** Not for CPU — for USB. The Pi 4 shares USB bandwidth and
power across ports in a way that causes brownouts when an ALFA AXML and an RTL-SDR run
simultaneously. The failure presents as a radio randomly disappearing, which is miserable to
diagnose and looks like a software bug.

| Item | Recommendation |
|---|---|
| Board | Pi 5, 4 GB minimum (8 GB if running the UI locally) |
| Power | Official 27 W USB-C PSU. Not a phone charger. |
| Storage | NVMe HAT, or a good A2 microSD. Detection logging writes constantly. |
| Cooling | Active cooler. Sustained DSP plus Wi-Fi capture makes it throttle otherwise. |
| USB | Put the two radios on **different** USB controllers; a powered hub if in doubt. |

**Symptom of undersized power:** everything works for 20 minutes, then a radio vanishes.
Check `dmesg` for USB resets before suspecting your code.

## OS

Raspberry Pi OS Bookworm (64-bit) or Ubuntu Server 24.04 arm64. Kernel must be **≥ 5.18** for
in-kernel `mt7921u`:

```bash
uname -r
```

## Base packages

```bash
sudo apt update && sudo apt install -y \
  build-essential pkg-config cmake git \
  python3-pip python3-venv \
  libusb-1.0-0-dev \
  libzmq3-dev \
  tcpdump tshark \
  aircrack-ng iw \
  firmware-misc-nonfree
```

`linux-firmware` is the Ubuntu name for these blobs and does not exist on
Raspberry Pi OS. Asking for it aborts the whole line before anything installs,
which reads as "none of these packages exist".

Toolchains:

```bash
# Go
curl -fsSL https://go.dev/dl/go1.26.5.linux-arm64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Node (for the UI)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**rustup's PATH edit only reaches login shells.** It installs to `~/.cargo/bin`
and adds it via `~/.profile`, which a non-login SSH command never reads — so
`ssh pi 'cargo build'` fails with `command not found` while the same command
works fine in an interactive session, which looks like a broken toolchain
rather than a missing profile. Verified on this unit. When scripting against
the Pi, use `~/.cargo/bin/cargo` or `bash -lc`; the same trap applies to
anything else that installs by editing `~/.bashrc` or `~/.profile`.

## Docker

The web tier (fusion, api, ui) runs in Compose on the Pi — see
[09-deployment.md](09-deployment.md) — so the deployment target needs the
engine and the compose plugin:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"     # then log out and back in
docker compose version              # the plugin, not legacy docker-compose
```

`make compose-up` shells out to `docker compose` (the v2 plugin syntax); the
standalone python `docker-compose` package in some distro repos is not the
same thing and ages badly.

## System tuning

**Disable Wi-Fi power management** — it will silently drop frames in monitor mode:

```bash
sudo iw dev wlan-alfa set power_save off
```

**Reduce SD card wear** if not using NVMe:

```bash
sudo systemctl disable systemd-journald-audit.socket
# journald to volatile storage
sudo sed -i 's/#Storage=auto/Storage=volatile/' /etc/systemd/journald.conf
```

**Time matters.** Detection timestamps drive fusion correlation, so keep NTP synced:

```bash
timedatectl status     # expect: System clock synchronized: yes
```

The Pi has **no RTC**, so every boot starts on `fake-hwclock`'s stale saved
time and jumps forward when NTP first answers — measured on this unit as a
7 h 51 min jump about fifty seconds after boot, with the sensors already
running. Detections stamped in that window keep the wrong time permanently.
The full write-up is in
[05-troubleshooting.md](05-troubleshooting.md#timestamps-or-uptime-look-wrong).
For field deployment with no network, fit an RTC or GPS module for time — or
accept that timestamps drift and that cross-sensor correlation degrades with
them.

## Next steps

1. [Wi-Fi adapter setup](02-wifi-adapter.md) — **read before plugging it in**
2. [SDR setup](03-sdr-setup.md) — the V4 needs a specific driver fork
3. [Deployment](09-deployment.md) — install the stack, run it under systemd
   and Compose, and update it in place

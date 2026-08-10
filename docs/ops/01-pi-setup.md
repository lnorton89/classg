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
  firmware-misc-nonfree linux-firmware
```

Toolchains:

```bash
# Go
curl -fsSL https://go.dev/dl/go1.23.0.linux-arm64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Node (for the UI)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## System tuning

**Disable Wi-Fi power management** — it will silently drop frames in monitor mode:

```bash
sudo iw dev wlan1 set power_save off
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

For field deployment with no network, add a GPS module for time — or accept that timestamps
drift and that cross-sensor correlation degrades with them.

## Next steps

1. [Wi-Fi adapter setup](02-wifi-adapter.md) — **read before plugging it in**
2. [SDR setup](03-sdr-setup.md) — the V4 needs a specific driver fork

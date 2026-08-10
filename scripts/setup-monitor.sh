#!/usr/bin/env bash
# Put a Wi-Fi adapter into PASSIVE monitor mode. Idempotent.
#
# Wire into the sensor's systemd unit as ExecStartPre= so monitor mode is
# re-established after a replug or restart.
#
# CRITICAL: never use `iw ... set monitor active` on mt7921u. Active monitor is a
# known driver bug that wedges the adapter until it is physically replugged.
#   https://github.com/openwrt/mt76/issues/839
# ClassG only ever receives, so passive is all we need anyway.

set -euo pipefail

IFACE="${1:-wlan1}"
CHANNEL="${2:-6}"

if [[ $EUID -ne 0 ]]; then
    echo "must run as root" >&2
    exit 1
fi

# Load the driver if it is present but not loaded. Under WSL this is the norm:
# udev does not autoload modules for a usbip-attached device, so the driver sits
# unloaded and no interface ever appears. No-op if already loaded.
if ! grep -qE "^mt7921u " /proc/modules 2>/dev/null && modinfo mt7921u >/dev/null 2>&1; then
    modprobe mt7921u && sleep 2
fi

if ! ip link show "$IFACE" >/dev/null 2>&1; then
    echo "interface $IFACE not found. Check: lsusb, dmesg | grep -i mt7921" >&2
    echo "If the driver loaded but the adapter never initialised, firmware blobs" >&2
    echo "are missing: apt install firmware-misc-nonfree linux-firmware" >&2
    echo "Run ./scripts/check-capture-env.sh for a full diagnosis." >&2
    exit 1
fi

# NetworkManager and wpa_supplicant will fight for the interface and silently
# steal it back mid-capture.
if command -v airmon-ng >/dev/null 2>&1; then
    airmon-ng check kill >/dev/null 2>&1 || true
else
    systemctl stop wpa_supplicant 2>/dev/null || true
    nmcli device set "$IFACE" managed no 2>/dev/null || true
fi

current_type=$(iw dev "$IFACE" info 2>/dev/null | awk '/type/ {print $2}')
if [[ "$current_type" != "monitor" ]]; then
    ip link set "$IFACE" down
    iw dev "$IFACE" set type monitor      # passive -- NOT 'set monitor active'
    ip link set "$IFACE" up
fi

iw dev "$IFACE" set channel "$CHANNEL"

# Power management silently drops frames in monitor mode.
iw dev "$IFACE" set power_save off 2>/dev/null || true

echo "$IFACE: passive monitor mode, channel $CHANNEL"
iw dev "$IFACE" info | sed 's/^/  /'

echo
echo "Sanity check before blaming your code:"
echo "  sudo tcpdump -i $IFACE -c 20 -e \"type mgt subtype beacon\""
echo "If that shows nothing, the problem is the adapter -- not the parser."

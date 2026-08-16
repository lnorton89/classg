#!/usr/bin/env bash
# Reload the mt7921u driver with a clean kernel log and capture what probe does.
#
#   sudo ./scripts/diagnose-adapter.sh
#
# Why this exists: a chatty kernel can flush a driver's probe messages straight
# out of the ring buffer. "No mt7921u messages in dmesg" therefore does NOT
# prove probe was silent -- it may just mean the evidence was overwritten. This
# clears the buffer first so what we see is real.

set -uo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "must run as root" >&2
    exit 1
fi

echo "=== before ==="
echo -n "  usb device: "; lsusb | grep -i 0e8d || echo "NOT PRESENT"
USB_DEV=$(find /sys/bus/usb/devices -maxdepth 2 -type f -name idVendor \
    -exec grep -lix 0e8d {} + 2>/dev/null | sed 's,/idVendor$,,' | head -1)
USB_SPEED=$(cat "$USB_DEV/speed" 2>/dev/null || echo "?")
echo "  link speed: $USB_SPEED"
echo -n "  phy:        "; find /sys/class/ieee80211 -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null; echo

echo
echo "=== unloading driver ==="
modprobe -r mt7921u 2>/dev/null
sleep 1

echo "=== clearing kernel log ==="
dmesg -C

echo "=== loading driver ==="
modprobe mt7921u
echo "  waiting 8s for firmware load and probe..."
sleep 8

echo
echo "=== what the driver actually said ==="
if dmesg | grep -iE "mt7921|mt76|firmware|usb" | head -40; then :; else
    echo "  (nothing - probe produced no output at all)"
fi

echo
echo "=== errors during that window ==="
dmesg -l err,warn 2>/dev/null | tail -20 || echo "  (none)"

echo
echo "=== after ==="
echo -n "  phy:        "; find /sys/class/ieee80211 -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null; echo
echo -n "  interfaces: "; iw dev 2>/dev/null | awk '/Interface/{printf "%s ", $2}'; echo
echo -n "  bound:      "; find /sys/bus/usb/drivers/mt7921u -mindepth 1 -maxdepth 1 -name '[0-9]*' -printf '%f ' 2>/dev/null; echo

echo
PHY_PATH=$(find /sys/class/ieee80211 -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)
if [ -n "$PHY_PATH" ]; then
    echo "SUCCESS: a wireless phy registered. Run ./scripts/check-capture-env.sh"
else
    cat <<'EOS'
STILL NO PHY.

The driver loaded but never registered a wireless phy. In order of likelihood:

  1. Firmware. mt7921u loads blobs at probe; without them probe fails and the
     result looks identical to a driver that never ran.
       ls /lib/firmware/mediatek/*7961*
       sudo apt install firmware-misc-nonfree

  2. Power. A brownout resets the device mid-probe and presents as a driver
     fault. `vcgencmd get_throttled` should read 0x0; anything else, or an
     "Undervoltage detected" in dmesg, means the supply is the problem. A Pi 4
     running this adapter alongside an SDR needs the 27 W supply or a powered
     hub -- see docs/ops/01-pi-setup.md.

  3. The port. Move it to a different USB controller, or through a powered hub.

See docs/ops/02-wifi-adapter.md.
EOS
fi

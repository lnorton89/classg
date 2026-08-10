#!/usr/bin/env bash
# Reload the mt7921u driver with a clean kernel log and capture what probe does.
#
#   sudo ./scripts/diagnose-adapter.sh
#
# Why this exists: under WSL, Docker Desktop's GPU shim spams
# "misc dxg: dxgk: dxgkio_query_adapter_info: Ioctl failed" continuously, which
# can flush a driver's probe messages straight out of the kernel ring buffer.
# "No mt7921u messages in dmesg" therefore does NOT prove probe was silent -- it
# may just mean the evidence was overwritten. This clears the buffer first so
# what we see is real.

set -uo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "must run as root" >&2
    exit 1
fi

echo "=== before ==="
echo -n "  usb device: "; lsusb | grep -i 0e8d || echo "NOT PRESENT"
echo -n "  link speed: "; cat /sys/bus/usb/devices/2-1/speed 2>/dev/null || echo "?"
echo -n "  phy:        "; ls /sys/class/ieee80211/ 2>/dev/null | tr '\n' ' '; echo

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
if dmesg | grep -iE "mt7921|mt76|firmware|usb" | grep -v dxg | head -40; then :; else
    echo "  (nothing - probe produced no output at all)"
fi

echo
echo "=== errors during that window ==="
dmesg -l err,warn 2>/dev/null | grep -v dxg | tail -20 || echo "  (none)"

echo
echo "=== after ==="
echo -n "  phy:        "; ls /sys/class/ieee80211/ 2>/dev/null | tr '\n' ' '; echo
echo -n "  interfaces: "; iw dev 2>/dev/null | awk '/Interface/{printf "%s ", $2}'; echo
echo -n "  bound:      "; ls /sys/bus/usb/drivers/mt7921u/ 2>/dev/null | grep -E '^[0-9]' | tr '\n' ' '; echo

echo
echo "=== usbip link state ==="
grep -vE "^hs .* 000000 0-0$" /sys/devices/platform/vhci_hcd.0/status 2>/dev/null | head -10

echo
if [ -n "$(ls /sys/class/ieee80211/ 2>/dev/null)" ]; then
    echo "SUCCESS: a wireless phy registered. Run ./scripts/check-capture-env.sh"
else
    cat <<'EOS'
STILL NO PHY.

The adapter is attached at USB 3.0 SuperSpeed (speed 5000). SuperSpeed devices
over usbip are the known-bad case: the bulk/control transfers the mt7921u probe
needs get tunnelled over TCP, and USB 3 devices frequently fail there while the
same device works fine at USB 2 high-speed.

Highest-value next step, and it is a physical one:

  1. On Windows:  usbipd detach --busid 2-9
  2. Physically move the adapter to a USB 2.0 port (a black port, not blue;
     or plug it through a cheap USB 2.0 hub, which forces high-speed).
  3. usbipd list          -> note the new busid, it will have changed
  4. usbipd bind   --busid <new>
     usbipd attach --wsl --busid <new>
  5. cat /sys/bus/usb/devices/*/speed   -> want 480, not 5000
  6. sudo ./scripts/diagnose-adapter.sh

If it still fails at high speed, this is where WSL stops being worth it -- the
Pi or a live USB will just work. See docs/ops/06-first-capture.md.
EOS
fi

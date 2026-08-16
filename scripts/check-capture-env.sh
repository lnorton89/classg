#!/usr/bin/env bash
# Preflight for the first capture. Run this BEFORE the drone is in the air.
#
# Works on a Pi or any Linux host. Answers one question: can this machine
# actually capture drone beacons? Every check prints PASS/FAIL/WARN and the
# script exits non-zero if anything blocking failed.
#
#   ./scripts/check-capture-env.sh [interface]

set -uo pipefail
IFACE="${1:-}"
FAIL=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=1; }
# NOT named `head` -- that shadowed coreutils `head`, so every `| head -1` in
# this script silently called the banner function instead and printed garbage.
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "Environment"
KREL=$(uname -r)
echo "  kernel: $KREL"
if [ -f /etc/os-release ]; then
    # Standard distro metadata file; it is optional here.
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "  os: ${PRETTY_NAME:-unknown}"
fi

section "Kernel wireless stack"
for m in cfg80211 mac80211; do
    if modinfo "$m" >/dev/null 2>&1 || grep -q "^$m " /proc/modules 2>/dev/null; then
        pass "$m available"
    else
        fail "$m missing - no wireless stack in this kernel"
    fi
done

section "MediaTek driver (AWUS036AXML / MT7921AU)"
FOUND_MT=0
for m in mt7921u mt7921_common mt76_usb mt76; do
    if modinfo "$m" >/dev/null 2>&1; then
        pass "$m present"
        FOUND_MT=1
    fi
done
if [ "$FOUND_MT" -eq 0 ]; then
    fail "no mt76/mt7921u driver for kernel $KREL - the adapter cannot bind, so no wlan interface will appear"
    echo "        Try: apt install firmware-misc-nonfree, then replug"
fi

# Driver present on disk is NOT the same as driver loaded. If udev does not
# autoload on hotplug, the module sits there unloaded and no interface ever
# appears -- a fully correct setup showing zero wireless interfaces.
MT_LOADED=0
if grep -qE "^(mt7921u|mt7921_common) " /proc/modules 2>/dev/null; then
    pass "mt7921u loaded"
    MT_LOADED=1
elif [ "$FOUND_MT" -eq 1 ]; then
    fail "mt7921u is present but NOT LOADED - nothing bound the adapter"
    echo "        Fix:  sudo modprobe mt7921u"
fi

section "Firmware"
# mt7921u loads firmware at probe. Missing blobs = driver loads, probe fails,
# no interface -- which looks identical to 'not loaded' unless you check.
shopt -s nullglob
MT7961_FIRMWARE=(/lib/firmware/mediatek/*7961*)
if [ "${#MT7961_FIRMWARE[@]}" -gt 0 ]; then
    pass "MT7961 firmware present (${#MT7961_FIRMWARE[@]} files)"
else
    fail "no MT7961 firmware in /lib/firmware/mediatek - driver will probe and fail"
    echo "        Fix:  sudo apt install firmware-misc-nonfree"
fi

section "USB device present"
if command -v lsusb >/dev/null 2>&1; then
    # 0e8d:7961 = MT7921AU (AWUS036AXML). 0bda:2838 = RTL2832U (RTL-SDR).
    if lsusb | grep -qi "0e8d:7961"; then
        pass "MT7921AU adapter enumerated ($(lsusb | grep -i '0e8d:7961' | head -1))"
    else
        fail "MT7921AU (0e8d:7961) not enumerated"
        echo "        Check the adapter is plugged in, and dmesg for a USB reset"
    fi
    if lsusb | grep -qi "0bda:2838"; then
        pass "RTL-SDR enumerated"
    else
        warn "RTL-SDR not present (not needed for the first capture)"
    fi
else
    warn "lsusb missing - install usbutils"
fi

section "Wireless interface"
if command -v iw >/dev/null 2>&1; then
    pass "iw present"
    IFACES=$(iw dev 2>/dev/null | awk '/Interface/{print $2}')
    if [ -n "$IFACES" ]; then
        pass "wireless interfaces: $(echo "$IFACES" | tr '\n' ' ')"
        if [ -z "$IFACE" ]; then
            IFACE=$(echo "$IFACES" | head -1)
        fi
    else
        fail "no wireless interfaces"
        # Point at the actual cause rather than a generic "did not bind".
        if [ "$FOUND_MT" -eq 1 ] && [ "$MT_LOADED" -eq 0 ]; then
            echo "        Cause: the driver is not loaded. Run: sudo modprobe mt7921u"
        elif [ "$MT_LOADED" -eq 1 ]; then
            echo "        Driver IS loaded but no interface appeared - probe failed."
            echo "        Check: sudo dmesg | grep -iE 'mt7921|mt76' | tail -20"
        else
            echo "        Cause: no MediaTek driver for this kernel (see above)."
        fi
    fi
else
    fail "iw missing - install iw"
fi

section "Monitor mode capability"
if [ -n "$IFACE" ] && command -v iw >/dev/null 2>&1; then
    PHY=$(iw dev "$IFACE" info 2>/dev/null | awk '/wiphy/{print "phy"$2}')
    if [ -n "$PHY" ]; then
        IW_PHY_INFO=$(iw phy "$PHY" info 2>/dev/null || true)
    else
        IW_PHY_INFO=""
    fi
    # Avoid grep -q directly on `iw` under pipefail: grep's early exit can give
    # iw SIGPIPE and incorrectly turn a successful match into a failed pipeline.
    if [ -n "$PHY" ] && grep -qi "\* monitor" <<<"$IW_PHY_INFO"; then
        pass "$IFACE ($PHY) advertises monitor mode"
    else
        warn "could not confirm monitor mode support on $IFACE"
    fi
    MODE=$(iw dev "$IFACE" info 2>/dev/null | awk '/type/{print $2}')
    echo "  current mode: ${MODE:-unknown}"
else
    warn "skipped - no interface to test"
fi

section "Capture tools"
if command -v tcpdump >/dev/null 2>&1; then
    pass "tcpdump present"
else
    fail "tcpdump missing - install tcpdump"
fi
for t in tshark python3; do
    if command -v "$t" >/dev/null 2>&1; then
        pass "$t present"
    else
        warn "$t missing (useful for analysis, not capture)"
    fi
done

section "Interference"
if command -v systemctl >/dev/null 2>&1; then
    for svc in NetworkManager wpa_supplicant; do
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            warn "$svc is running - it will steal the interface mid-capture. Run: sudo airmon-ng check kill"
        else
            pass "$svc not running"
        fi
    done
fi

section "Result"
if [ "$FAIL" -eq 0 ]; then
    echo "  Ready to capture. Next: sudo ./scripts/first-capture.sh ${IFACE:-wlan1}"
    exit 0
fi
echo "  Blocking failures above. See docs/ops/06-first-capture.md"
exit 1

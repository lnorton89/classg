#!/usr/bin/env bash
# Preflight for the first capture. Run this BEFORE the drone is in the air.
#
# Works on a Pi, a live USB, or WSL. Answers one question: can this machine
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
if grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=1
    # A trailing '+' on the release string means a locally built kernel, which
    # is exactly what the mt76 driver requires here.
    case "$KREL" in
        *+) pass "running under WSL on a custom kernel (mt76 support expected)" ;;
        *)  warn "running under WSL on a stock kernel - it has no mt76 driver. See ./scripts/wsl-build-kernel.sh" ;;
    esac
else
    IS_WSL=0
fi
[ -f /etc/os-release ] && . /etc/os-release && echo "  os: ${PRETTY_NAME:-unknown}"

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
    if [ "$IS_WSL" -eq 1 ]; then
        echo "        WSL's stock kernel omits these. Build one: ./scripts/wsl-build-kernel.sh"
    else
        echo "        Try: apt install firmware-misc-nonfree linux-firmware, then replug"
    fi
fi

# Driver present on disk is NOT the same as driver loaded. WSL does not run
# udev the way a normal distro does, so a hot-plugged (usbip-attached) device
# does not trigger module autoloading -- the module just sits there unloaded and
# no interface ever appears. This is the single most likely reason a fully
# correct setup still shows zero wireless interfaces.
MT_LOADED=0
if grep -qE "^(mt7921u|mt7921_common) " /proc/modules 2>/dev/null; then
    pass "mt7921u loaded"
    MT_LOADED=1
elif [ "$FOUND_MT" -eq 1 ]; then
    fail "mt7921u is present but NOT LOADED - nothing bound the adapter"
    echo "        Fix:  sudo modprobe mt7921u"
    [ "$IS_WSL" -eq 1 ] && echo "        (expected under WSL: no udev autoload on usbip attach)"
fi

section "Firmware"
# mt7921u loads firmware at probe. Missing blobs = driver loads, probe fails,
# no interface -- which looks identical to 'not loaded' unless you check.
if ls /lib/firmware/mediatek/ 2>/dev/null | grep -qi 7961; then
    pass "MT7961 firmware present ($(ls /lib/firmware/mediatek/ | grep -ci 7961) files)"
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
        [ "$IS_WSL" -eq 1 ] && echo "        On WSL you must forward it: usbipd attach --wsl --busid <BUSID>"
    fi
    lsusb | grep -qi "0bda:2838" && pass "RTL-SDR enumerated" || warn "RTL-SDR not present (not needed for the first capture)"
else
    warn "lsusb missing - install usbutils"
fi

section "Wireless interface"
if command -v iw >/dev/null 2>&1; then
    pass "iw present"
    IFACES=$(iw dev 2>/dev/null | awk '/Interface/{print $2}')
    if [ -n "$IFACES" ]; then
        pass "wireless interfaces: $(echo "$IFACES" | tr '\n' ' ')"
        [ -z "$IFACE" ] && IFACE=$(echo "$IFACES" | head -1)
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
    if [ -n "$PHY" ] && iw phy "$PHY" info 2>/dev/null | grep -qi "\* monitor"; then
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
for t in tcpdump; do
    command -v "$t" >/dev/null 2>&1 && pass "$t present" || fail "$t missing - install $t"
done
for t in tshark python3; do
    command -v "$t" >/dev/null 2>&1 && pass "$t present" || warn "$t missing (useful for analysis, not capture)"
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

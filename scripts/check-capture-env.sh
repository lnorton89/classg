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
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

head "Environment"
KREL=$(uname -r)
echo "  kernel: $KREL"
if grep -qi microsoft /proc/version 2>/dev/null; then
    warn "running under WSL - see docs/ops/06-first-capture.md, the stock WSL2 kernel has no mt76 driver"
    IS_WSL=1
else
    IS_WSL=0
fi
[ -f /etc/os-release ] && . /etc/os-release && echo "  os: ${PRETTY_NAME:-unknown}"

head "Kernel wireless stack"
for m in cfg80211 mac80211; do
    if modinfo "$m" >/dev/null 2>&1 || grep -q "^$m " /proc/modules 2>/dev/null; then
        pass "$m available"
    else
        fail "$m missing - no wireless stack in this kernel"
    fi
done

head "MediaTek driver (AWUS036AXML / MT7921AU)"
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
        echo "        WSL's stock kernel omits these. Options in docs/ops/06-first-capture.md"
    else
        echo "        Try: apt install firmware-misc-nonfree linux-firmware, then replug"
    fi
fi

head "USB device present"
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

head "Wireless interface"
if command -v iw >/dev/null 2>&1; then
    pass "iw present"
    IFACES=$(iw dev 2>/dev/null | awk '/Interface/{print $2}')
    if [ -n "$IFACES" ]; then
        pass "wireless interfaces: $(echo "$IFACES" | tr '\n' ' ')"
        [ -z "$IFACE" ] && IFACE=$(echo "$IFACES" | head -1)
    else
        fail "no wireless interfaces - driver did not bind the adapter"
    fi
else
    fail "iw missing - install iw"
fi

head "Monitor mode capability"
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

head "Capture tools"
for t in tcpdump; do
    command -v "$t" >/dev/null 2>&1 && pass "$t present" || fail "$t missing - install $t"
done
for t in tshark python3; do
    command -v "$t" >/dev/null 2>&1 && pass "$t present" || warn "$t missing (useful for analysis, not capture)"
done

head "Interference"
if command -v systemctl >/dev/null 2>&1; then
    for svc in NetworkManager wpa_supplicant; do
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            warn "$svc is running - it will steal the interface mid-capture. Run: sudo airmon-ng check kill"
        else
            pass "$svc not running"
        fi
    done
fi

head "Result"
if [ "$FAIL" -eq 0 ]; then
    echo "  Ready to capture. Next: sudo ./scripts/first-capture.sh ${IFACE:-wlan1}"
    exit 0
fi
echo "  Blocking failures above. See docs/ops/06-first-capture.md"
exit 1

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

# The mt7921u and vendor rtl8852au drivers share the Pi 4's USB 2 path even
# when the dongles are physically in blue ports. Starting both units at boot
# used to run `ip link` and `iw` concurrently; both calls entered uninterruptible
# kernel sleep and pinned the boot transaction. Serialize all monitor-mode
# transitions, including watchdog restarts and manual invocations.
exec 9>/run/lock/classg-wifi-monitor.lock
if ! flock -w 90 9; then
    echo "timed out waiting for another Wi-Fi adapter setup to finish" >&2
    exit 1
fi

# Load the driver if it is present but not loaded. The ALFA uses the in-kernel
# mt7921u driver; the TP-Link uses rtl8852au on the Pi's current 6.12 kernel.
# The TP-Link also appears briefly as a USB storage device before udev
# mode-switches it, so wait for that sequence to produce the stable interface.
driver=""
case "$IFACE" in
    wlan-alfa)   driver=mt7921u ;;
    wlan-tplink) driver=8852au ;;
esac

if [[ -n "$driver" ]] && ! grep -qE "^${driver} " /proc/modules 2>/dev/null; then
    if modinfo "$driver" >/dev/null 2>&1; then
        modprobe "$driver"
        udevadm settle --timeout=10 2>/dev/null || true
    else
        echo "driver $driver is not installed for kernel $(uname -r)" >&2
        echo "check DKMS after a kernel update:  dkms status" >&2
        exit 1
    fi
fi

for _ in {1..20}; do
    ip link show "$IFACE" >/dev/null 2>&1 && break
    sleep 0.25
done

if ! ip link show "$IFACE" >/dev/null 2>&1; then
    echo "interface $IFACE not found. Check: lsusb, dkms status, and dmesg" >&2
    if [[ "$driver" == "mt7921u" ]]; then
        echo "If mt7921u loaded but the ALFA never initialised, install" >&2
        echo "firmware-misc-nonfree." >&2
    elif [[ "$driver" == "8852au" ]]; then
        echo "The TP-Link needs rtl8852au built for the running kernel." >&2
    fi
    echo "Run ./scripts/check-capture-env.sh for a full diagnosis." >&2
    exit 1
fi

# NetworkManager and wpa_supplicant will fight for the interface and silently
# steal it back mid-capture.
#
# `airmon-ng check kill` clears them thoroughly, but it stops both daemons
# system-wide. On a headless Pi that is usually how you are connected, so the
# thorough option can take the box off the network mid-configuration and leave
# physical access as the only way back. Escalate to it only when the default
# route does not depend on either daemon; otherwise release just $IFACE, which
# is all passive monitor actually needs.
route_dev=$(ip route show default 2>/dev/null | awk '{print $5; exit}')

kill_all_is_safe() {
    [[ -z "$route_dev" ]] && return 0             # nothing to lose
    [[ "$route_dev" == "$IFACE" ]] && return 1    # routing over the capture NIC
    # A wireless route is held up by wpa_supplicant.
    [[ -d "/sys/class/net/$route_dev/wireless" ]] && return 1
    # A NetworkManager-managed route dies with NetworkManager.
    if command -v nmcli >/dev/null 2>&1; then
        nmcli -t -f DEVICE,STATE device status 2>/dev/null \
            | grep -qx "$route_dev:connected" && return 1
    fi
    return 0
}

if command -v airmon-ng >/dev/null 2>&1 && kill_all_is_safe; then
    airmon-ng check kill >/dev/null 2>&1 || true
else
    # Targeted release. Marking the device unmanaged is enough on
    # NetworkManager systems; a standalone wpa_supplicant bound to this
    # interface needs stopping too, but a system-wide one does not.
    nmcli device set "$IFACE" managed no 2>/dev/null || true
    if pgrep -f "wpa_supplicant.*$IFACE" >/dev/null 2>&1; then
        systemctl stop wpa_supplicant 2>/dev/null || true
    fi
fi

current_type=$(iw dev "$IFACE" info 2>/dev/null | awk '/type/ {print $2}')
if [[ "$current_type" != "monitor" ]]; then
    # NetworkManager's "unmanaged" transition is asynchronous. A freshly
    # mode-switched rtl8852au device returned EBUSY on the first conversion and
    # worked five seconds later. Retry that expected handoff locally instead of
    # burning a whole systemd restart.
    monitor_ready=0
    for attempt in {1..6}; do
        ip link set "$IFACE" down 2>/dev/null || true
        if iw dev "$IFACE" set type monitor; then  # passive -- never "active"
            ip link set "$IFACE" up
            monitor_ready=1
            break
        fi
        [[ $attempt -lt 6 ]] && sleep 1
    done
    if [[ $monitor_ready -ne 1 ]]; then
        echo "could not put $IFACE in monitor mode after 6 attempts" >&2
        exit 1
    fi
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

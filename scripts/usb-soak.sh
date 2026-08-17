#!/usr/bin/env bash
# Watch both radios until one of them lets go, and record the state either side.
#
# Why this exists: on 2026-08-16 the AWUS036AXML dropped off the USB bus after
# 4 h 11 min alongside the SDR, with `throttled=0x0` recorded -- a clean
# disconnect rather than the brownout [01-pi-setup] warns about. Cause
# unestablished. The roadmap's one-hour power test now passes comfortably
# (2 h 10 min on 2026-08-17, no disconnects), so the hour is no longer the
# question; what is missing is a record of what the unit looked like in the
# minutes before a dropout that happens hours in.
#
# Enumeration alone is not the test. A radio can sit on the bus with its driver
# no longer delivering anything, which reads as healthy to `lsusb` and as a dead
# sky to an operator. Every sample therefore also reads a counter that only
# advances while frames are genuinely arriving.
#
# Read-only: it inspects sysfs, dmesg and the local API, and changes nothing.

set -uo pipefail

INTERVAL="${1:-60}"
LOG="${2:-$HOME/classg-usb-soak.tsv}"
API="${CLASSG_API:-http://localhost:8081}"

# The two radios this project depends on, by USB ID rather than by interface
# name -- wlan1 is assigned by udev and moves, the ID does not.
SDR_ID="0bda:2838"   # Realtek RTL2838, the RTL-SDR V4
WIFI_ID="0e8d:7961"  # MediaTek MT7921U, the AWUS036AXML

started_at="$(date +%s)"

# dmesg is root-only under Bookworm's kernel.dmesg_restrict. Ask once rather
# than per sample, and carry on without it rather than failing: the USB
# presence checks below are the primary signal and need no privilege.
DMESG="cat /dev/null"
if dmesg >/dev/null 2>&1; then
    DMESG="dmesg"
elif sudo -n true 2>/dev/null && sudo -n dmesg >/dev/null 2>&1; then
    DMESG="sudo -n dmesg"
else
    echo "note: no access to dmesg, USB error counts will read 0" >&2
fi

usb_present() { lsusb 2>/dev/null | grep -qi "$1" && echo 1 || echo 0; }

# `grep -c` prints its count AND exits 1 when that count is zero, so the obvious
# `|| echo 0` emits a second value and every row lands split across two lines.
# Swallow the status instead and keep grep's own number.
usb_errors() {
    $DMESG 2>/dev/null |
        grep -icE "disconnect|over-current|device descriptor read|not responding" || true
}

restarts() { systemctl show "$1" -p NRestarts --value 2>/dev/null || echo "?"; }

# A counter that only moves while frames arrive. Wi-Fi reports beacons, the SDR
# reports messages read from dump1090; either standing still while the device is
# still enumerated is the failure this script exists to catch.
api_counter() {
    curl -sS --max-time 5 "$API/api/v1/health" 2>/dev/null |
        python3 -c "
import json,sys
try: d = json.load(sys.stdin)
except Exception: print('?', '?'); raise SystemExit
w = s = '?'
for x in d.get('sensors', []):
    det = x.get('detail') or {}
    if x.get('sensor_kind') == 'wifi': w = det.get('beacons', '?')
    if x.get('sensor_kind') == 'sdr':  s = det.get('messages_read', '?')
print(w, s)
" 2>/dev/null || echo "? ?"
}

# Seconds since boot, which is the axis the 2026-08-16 dropout sits on. Elapsed
# time since this script started is not comparable to it -- sampling usually
# begins hours into a run -- so both are recorded and up_s is the one to read
# against the 15060 s mark.
uptime_s() { cut -d. -f1 /proc/uptime; }

if [ ! -s "$LOG" ]; then
    printf 'up_s\telapsed_s\twall\tsdr\twifi\tusb_err\trs_wifi\trs_sdr\tthrottled\ttemp\tbeacons\tmsgs\n' >"$LOG"
fi

echo "sampling every ${INTERVAL}s into $LOG -- Ctrl-C to stop"
echo "watch up_s, not elapsed_s: the 2026-08-16 dropout sits at 4 h 11 min (up_s 15060)"
echo "this unit is at up_s $(uptime_s) now"

# A counter repeating once means nothing: sensors publish heartbeats on their
# own interval, the API reports the last one it saw, and ADS-B reception is
# bursty enough that the roadmap warns against diagnosing a receiver from one
# short window. Only a run of identical samples is evidence of a wedge.
STALL_LIMIT="${STALL_LIMIT:-3}"

prev_beacons="" prev_msgs=""
wifi_stall=0 sdr_stall=0

while true; do
    elapsed=$(( $(date +%s) - started_at ))
    sdr="$(usb_present "$SDR_ID")"
    wifi="$(usb_present "$WIFI_ID")"
    read -r beacons msgs <<<"$(api_counter)"

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$(uptime_s)" "$elapsed" "$(date +%H:%M:%S)" "$sdr" "$wifi" "$(usb_errors)" \
        "$(restarts classg-sensor-wifi)" "$(restarts classg-sensor-sdr)" \
        "$(vcgencmd get_throttled 2>/dev/null || echo n/a)" \
        "$(vcgencmd measure_temp 2>/dev/null || echo n/a)" \
        "$beacons" "$msgs" >>"$LOG"

    # Report regressions on stdout as they happen. Nobody watches a TSV grow,
    # and the whole point is to catch the moment rather than to find it later.
    [ "$sdr" = 0 ] && echo "!! ${elapsed}s: SDR $SDR_ID is gone from the bus"
    [ "$wifi" = 0 ] && echo "!! ${elapsed}s: Wi-Fi $WIFI_ID is gone from the bus"
    if [ -n "$prev_beacons" ] && [ "$beacons" = "$prev_beacons" ]; then
        wifi_stall=$((wifi_stall + 1))
    else
        wifi_stall=0
    fi
    if [ -n "$prev_msgs" ] && [ "$msgs" = "$prev_msgs" ]; then
        sdr_stall=$((sdr_stall + 1))
    else
        sdr_stall=0
    fi

    # Enumerated but not delivering is the failure mode `lsusb` cannot see, and
    # the one that looks like a quiet sky to an operator.
    if [ "$wifi_stall" -ge "$STALL_LIMIT" ] && [ "$wifi" = 1 ]; then
        echo "!! ${elapsed}s: Wi-Fi on the bus but beacons stuck at $beacons for $wifi_stall samples"
    fi
    if [ "$sdr_stall" -ge "$STALL_LIMIT" ] && [ "$sdr" = 1 ]; then
        echo "?? ${elapsed}s: ADS-B stuck at $msgs for $sdr_stall samples (bursty reception can do this)"
    fi

    prev_beacons="$beacons" prev_msgs="$msgs"

    sleep "$INTERVAL"
done

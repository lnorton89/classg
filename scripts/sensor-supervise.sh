#!/usr/bin/env bash
# Keep the Wi-Fi sensor running across adapter drops. Runs as root.
#
# Why this exists: the capture watchdog exits a wedged process so the sensor
# reads as absent rather than blind (ADR-0003). That is the right behaviour, but
# on its own it converts a five-minute wedge into permanent silence -- nothing
# starts it again. Over one evening the usbip link between Windows and WSL
# dropped three times; each drop ended recording until someone noticed.
#
# Deliberately one `sudo` for the whole supervisor rather than one per restart.
# The sensor needs root for AF_PACKET and `iw` needs it to restore monitor mode,
# and sudo's credential cache expires in minutes -- a loop that re-sudoed would
# work until the first drop after the cache went cold, which is precisely when
# it is needed.
#
# It does NOT reattach the USB device. That is a usbipd command on the Windows
# side, out of reach from here. When the adapter is gone this waits, says so,
# and picks up by itself once it returns.

set -uo pipefail

IFACE="${1:?usage: sensor-supervise.sh <iface>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

MIN_BACKOFF_S=2
MAX_BACKOFF_S=60
# A run this short did not achieve anything, so the next wait grows. Anything
# longer is treated as a working session and resets the backoff.
HEALTHY_RUN_S=60

backoff=$MIN_BACKOFF_S
child=""

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') supervisor: $*"; }

# Stopping the supervisor must stop the capture with it. Otherwise `make
# dev-down` leaves a root-owned python holding the radio in monitor mode, and
# the next start finds the interface busy for reasons nothing explains.
shutdown() {
    trap - TERM INT
    if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
        log "stopping capture (pid $child)"
        kill "$child" 2>/dev/null
        # SIGTERM lets the sensor publish its final unhealthy heartbeat, so the
        # UI shows a stopped sensor rather than one that simply went quiet.
        for _ in $(seq 1 20); do
            kill -0 "$child" 2>/dev/null || break
            sleep 0.25
        done
        kill -9 "$child" 2>/dev/null
    fi
    log "supervisor stopped"
    exit 0
}
trap shutdown TERM INT

log "supervising $IFACE (pid $$)"

while true; do
    if ! ip link show "$IFACE" >/dev/null 2>&1; then
        log "$IFACE is gone; waiting for the adapter to come back (usbipd attach on the Windows side)"
        sleep "$backoff"
        backoff=$(( backoff * 2 )); [ "$backoff" -gt "$MAX_BACKOFF_S" ] && backoff=$MAX_BACKOFF_S
        continue
    fi

    # A re-attached adapter comes back in managed mode, so monitor has to be
    # restored before every run rather than assumed from the last one.
    mode=$(iw dev "$IFACE" info 2>/dev/null | awk '/type/ {print $2}')
    if [ "$mode" != "monitor" ]; then
        log "$IFACE is in '${mode:-unknown}' mode; restoring monitor"
        if ! ./scripts/setup-monitor.sh "$IFACE" 2>&1; then
            log "could not put $IFACE into monitor mode; retrying in ${backoff}s"
            sleep "$backoff"
            backoff=$(( backoff * 2 )); [ "$backoff" -gt "$MAX_BACKOFF_S" ] && backoff=$MAX_BACKOFF_S
            continue
        fi
    fi

    started=$(date +%s)
    log "starting capture on $IFACE"
    # Backgrounded and waited on rather than run in the foreground, so the trap
    # above knows which process to stop. Killing the supervisor alone would
    # orphan a root-owned capture that keeps holding the radio.
    ( cd services/sensor-wifi && exec .venv/bin/python -m classg_wifi.cli run --iface "$IFACE" ) 2>&1 &
    child=$!
    wait "$child"
    code=$?
    child=""
    ran=$(( $(date +%s) - started ))

    if [ "$code" -eq 0 ]; then
        log "capture exited cleanly after ${ran}s; supervisor stopping"
        exit 0
    fi

    if [ "$ran" -ge "$HEALTHY_RUN_S" ]; then
        # It worked for a while, so this is a fresh fault rather than a loop.
        backoff=$MIN_BACKOFF_S
    fi

    log "capture exited ${code} after ${ran}s; restarting in ${backoff}s"
    sleep "$backoff"
    if [ "$ran" -lt "$HEALTHY_RUN_S" ]; then
        backoff=$(( backoff * 2 )); [ "$backoff" -gt "$MAX_BACKOFF_S" ] && backoff=$MAX_BACKOFF_S
    fi
done

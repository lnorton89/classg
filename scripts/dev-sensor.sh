#!/usr/bin/env bash
# Start the Wi-Fi sensor alongside the Docker dev stack.
#
# Why this exists: "the stack is up" has to mean "the sky is being watched". A
# dev stack that brings up the UI, API and fusion but not the sensor produces a
# system that reports `recording: true` while no radio is running -- an empty
# map that looks like a quiet sky rather than a missing sensor. Recording being
# on is a statement about a switch; coverage is a statement about the world, and
# only the second one matters.
#
# The sensor runs NATIVELY, not in a container. It needs AF_PACKET on a monitor
# -mode interface, and under WSL the adapter belongs to the WSL kernel rather
# than to Docker's VM -- a container cannot see it. See docker/README.md.
#
# This never fails the stack. A missing adapter is an expected state on a dev
# box, so it explains itself and exits 0; the UI's health banner then reports
# the same absence, and the two agree.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

IFACE="${1:-${IFACE:-wlan1}}"
RUN_DIR=".dev"
LOG="$RUN_DIR/sensor.log"
PIDFILE="$RUN_DIR/sensor.pid"

mkdir -p "$RUN_DIR"

skip() {
    echo "  sensor NOT started: $1"
    [ -n "${2:-}" ] && echo "  $2"
    echo "  the stack is up, but there is no coverage until a sensor is running."
    exit 0
}

# Already running? Do not start a second one -- two processes on one monitor
# interface produce duplicate detections that look like a real second aircraft.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    echo "  sensor already running (pid $(cat "$PIDFILE"))"
    exit 0
fi

if ! command -v ip >/dev/null 2>&1; then
    skip "no 'ip' command, so the interface cannot be checked"
fi

# The requested name is a preference, not a requirement. Interface numbering is
# assigned by the kernel in probe order, so the same adapter comes up wlan0 on
# one boot and wlan1 on the next -- and a stack that skips the sensor because it
# looked for the wrong name is indistinguishable from having no adapter, which
# is the exact confusion this script exists to end.
if ! ip link show "$IFACE" >/dev/null 2>&1; then
    DETECTED=$(iw dev 2>/dev/null | awk '/Interface/ {print $2}')
    COUNT=$(printf '%s\n' "$DETECTED" | grep -c . || true)

    if [ "$COUNT" -eq 0 ]; then
        skip "no wireless interface exists (looked for $IFACE)" \
             "attach the adapter first. Under WSL: usbipd attach --busid <id>, then 'make monitor'."
    elif [ "$COUNT" -gt 1 ]; then
        # Guessing between two radios could put the sensor on the one that is
        # carrying your network connection.
        skip "$IFACE does not exist and there is more than one candidate: $(printf '%s' "$DETECTED" | tr '\n' ' ')" \
             "pick one: make dev-sensor IFACE=<iface>"
    fi

    echo "  $IFACE does not exist; using the only wireless interface, $DETECTED"
    IFACE="$DETECTED"
fi

# Monitor mode is not optional: in managed mode the adapter only ever hands up
# frames addressed to it, so the sensor would run happily and see no beacons.
MODE=$(iw dev "$IFACE" info 2>/dev/null | awk '/type/ {print $2}')
if [ "$MODE" != "monitor" ]; then
    skip "$IFACE is in '${MODE:-unknown}' mode, not monitor" \
         "run: make monitor IFACE=$IFACE"
fi

VENV="services/sensor-wifi/.venv/bin/python"
if [ ! -x "$VENV" ]; then
    skip "the sensor venv is missing ($VENV)" \
         "run: make setup-wifi"
fi

# sudo is required for AF_PACKET. Check non-interactively rather than letting it
# prompt: `make dev` is often left running unattended, and a silent password
# prompt behind the compose output looks exactly like a hang.
if ! sudo -n true 2>/dev/null; then
    skip "sudo needs a password and this step will not prompt" \
         "run in another terminal: make sense IFACE=$IFACE"
fi

echo "  starting the Wi-Fi sensor on $IFACE (log: $LOG)"
# Supervised, not bare. The capture watchdog exits a wedged process so the
# sensor reads as absent rather than blind, which is right -- but on its own it
# turns a transient USB drop into permanent silence. The supervisor restores
# monitor mode and restarts, and waits it out when the adapter is gone entirely.
nohup sudo ./scripts/sensor-supervise.sh "$IFACE" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"

# Confirm it survived startup. Reporting "started" for a process that died on a
# vanished adapter would be the same lie this script exists to prevent.
sleep 3
if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "  sensor exited immediately; last lines of $LOG:"
    tail -n 15 "$LOG" | sed 's/^/    /'
    rm -f "$PIDFILE"
    exit 0
fi
echo "  sensor running under supervision (pid $(cat "$PIDFILE"))"

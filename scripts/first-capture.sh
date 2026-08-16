#!/usr/bin/env bash
# Milestone 0: capture the DJI's beacons. Run as root.
#
#   sudo ./scripts/first-capture.sh [interface] [channel] [seconds]
#
# Deliberately captures on ONE fixed channel. Channel hopping during the very
# first capture means an empty file tells you nothing -- you cannot distinguish
# "the drone is silent" from "we were listening elsewhere". Lock the channel,
# prove capture works, then tune hopping later.
#
# If channel 6 yields nothing, sweep with: ./scripts/first-capture.sh wlan1 sweep

set -euo pipefail

IFACE="${1:-wlan1}"
CHANNEL="${2:-6}"
DURATION="${3:-120}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/captures"
STAMP=$(date +%Y%m%d-%H%M%S)

if [[ $EUID -ne 0 ]]; then
    echo "must run as root (monitor mode + packet capture)" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

# --- channel sweep mode: find where the drone actually beacons -----------------
if [[ "$CHANNEL" == "sweep" ]]; then
    echo "Sweeping 2.4 GHz for drone vendor IEs. Power the drone ON now."
    echo "Looking for OUI 26:37:12 (DJI DroneID) and fa:0b:bc (ASTM F3411)."
    echo
    for ch in 1 6 11 2 3 4 5 7 8 9 10 12 13; do
        iw dev "$IFACE" set channel "$ch" 2>/dev/null || continue
        printf 'ch %-3s ' "$ch"
        # 6 s per channel: beacons are ~1 Hz, so this is several chances each.
        hits=$(timeout 6 tcpdump -i "$IFACE" -c 200 -e -x "type mgt subtype beacon" 2>/dev/null \
               | grep -ciE '2637 12|fa0b bc' || true)
        if [[ "$hits" -gt 0 ]]; then
            echo "*** $hits drone IE hits ***"
        else
            echo "-"
        fi
    done
    echo
    echo "Re-run on the winning channel: sudo $0 $IFACE <channel>"
    exit 0
fi

# --- setup --------------------------------------------------------------------
echo "== Preparing $IFACE on channel $CHANNEL =="

# If udev did not autoload the driver on hotplug, the module sits unloaded and
# no interface appears. Harmless
# to run everywhere -- modprobe on an already-loaded module is a no-op.
if ! grep -qE "^mt7921u " /proc/modules 2>/dev/null; then
    if modinfo mt7921u >/dev/null 2>&1; then
        echo "  loading mt7921u"
        modprobe mt7921u || echo "  WARNING: modprobe mt7921u failed"
        sleep 2   # give the driver time to probe and register the interface
    fi
fi

# Not `A && B || true`: that reads as if-then-else but runs the fallback when A
# succeeds and B fails too. Killing the interfering processes is best-effort
# either way, so say so explicitly.
if command -v airmon-ng >/dev/null 2>&1; then
    airmon-ng check kill >/dev/null 2>&1 || true
fi

if ! ip link show "$IFACE" >/dev/null 2>&1; then
    echo "  interface $IFACE not found. Available wireless interfaces:" >&2
    iw dev 2>/dev/null | awk '/Interface/{print "    " $2}' >&2
    echo "  Run ./scripts/check-capture-env.sh to diagnose." >&2
    exit 1
fi

if [[ "$(iw dev "$IFACE" info 2>/dev/null | awk '/type/{print $2}')" != "monitor" ]]; then
    ip link set "$IFACE" down
    # PASSIVE monitor only. 'set monitor active' wedges mt7921u until replug.
    iw dev "$IFACE" set type monitor
    ip link set "$IFACE" up
fi
iw dev "$IFACE" set channel "$CHANNEL"
iw dev "$IFACE" set power_save off 2>/dev/null || true
iw dev "$IFACE" info | sed 's/^/  /'

# --- sanity check: are ANY beacons arriving? ----------------------------------
echo
echo "== Checking the interface hears anything at all =="
BASELINE=$(timeout 10 tcpdump -i "$IFACE" -c 20 "type mgt subtype beacon" 2>/dev/null | wc -l || true)
if [[ "$BASELINE" -eq 0 ]]; then
    echo "  No beacons from ANY network in 10s. The problem is the adapter or"
    echo "  monitor mode, not the drone. Stop here and fix that first:"
    echo "    docs/ops/05-troubleshooting.md"
    exit 1
fi
echo "  $BASELINE beacons seen - capture path works."

# --- capture ------------------------------------------------------------------
PCAP="$OUT_DIR/$STAMP-dji-first-flight.pcap"
echo
echo "== Capturing to $PCAP for ${DURATION}s =="
echo "   Power on the drone, let it acquire GPS, hover, land."
echo "   Ctrl-C to stop early."
echo

# Capture beacons only. Filtering in the kernel keeps neighbours' data frames
# out of userspace entirely -- see docs/research/06-legal-and-ethics.md.
timeout "$DURATION" tcpdump -i "$IFACE" -w "$PCAP" -s 0 "type mgt subtype beacon" || true

# --- immediate triage ---------------------------------------------------------
echo
echo "== Result =="
if [[ ! -s "$PCAP" ]]; then
    echo "  Empty capture."
    exit 1
fi
SIZE=$(du -h "$PCAP" | cut -f1)
COUNT=$(tcpdump -r "$PCAP" 2>/dev/null | wc -l || echo "?")
echo "  $PCAP ($SIZE, $COUNT frames)"

DJI=$(tcpdump -r "$PCAP" -x 2>/dev/null | grep -ci '2637 12' || true)
ODID=$(tcpdump -r "$PCAP" -x 2>/dev/null | grep -ci 'fa0b bc' || true)
echo "  DJI DroneID (26:37:12) byte hits: $DJI"
echo "  ASTM F3411  (fa:0b:bc) byte hits: $ODID"

if [[ "$DJI" -eq 0 && "$ODID" -eq 0 ]]; then
    cat <<'EOS'

  No drone IEs found. Before assuming a bug, rule these out in order:
    1. Wrong channel      -> sudo ./scripts/first-capture.sh <iface> sweep
    2. Drone not broadcasting Remote ID -> confirm with the OpenDroneID
       receiver app on an Android phone; not all models/firmware broadcast
       over Wi-Fi, some are Bluetooth-only
    3. Too far away       -> capture from within ~50 m for the first test
EOS
    exit 1
fi

cat <<EOS

  Drone IEs present. Now decode them with our own parsers:

    cd services/sensor-wifi
    python3 -m venv .venv
    .venv/bin/python -m pip install -e '.[replay]'
    .venv/bin/python -m classg_wifi.cli analyze ../../$(basename "$PCAP" | sed 's|^|captures/|')

  That prints the calibration values for docs/ops/04-calibration.md.
EOS

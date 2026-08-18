#!/usr/bin/env bash
# Run band sweeps on behalf of the API, which cannot.
#
# The API is containerised and has no sensor binary, no /dev/bus/usb and no
# librtlsdr -- all three checked absent on the unit. So `spectrum.sdr_bin` could
# never point at anything real and the Spectrum page reported "no sweep engine
# configured" permanently. The alternatives were to give a web-facing container
# the radio, or to hand the work to something already on the host holding the
# privileges. This is the second, and the same file exchange the deploy agent
# and the watchdog already use.
#
# The API writes spectrum-request.json; this writes spectrum-result-<id>.json
# back. Nothing else crosses the boundary.
#
# It yields the radio, and that is the part worth understanding. dump1090 owns
# the dongle on a working unit (ADR-0008) and a sweep cannot share it, so a
# sweep stops dump1090, measures, and starts it again -- ADS-B is blind for the
# duration. The web app says so before the button is pressed.
#
# Restoring it is handled in three places because "the sweep ended" has three
# shapes: the sweep returned, systemd stopped the agent mid-measurement, or the
# agent was killed outright. Traps cover the first two; the unit's ExecStopPost
# covers the third, since nothing in this file runs after SIGKILL.

set -uo pipefail

REPO_DIR="${CLASSG_REPO_DIR:-$HOME/classg}"
STATE_DIR="${CLASSG_DEPLOY_STATE:-$REPO_DIR/.agent-state}"
SDR_BIN="${CLASSG_SDR_BIN:-$REPO_DIR/services/sensor-sdr/target/release/classg-sensor-sdr}"
DUMP1090_UNIT="${CLASSG_DUMP1090_UNIT:-dump1090-mutability.service}"
POLL_S="${CLASSG_SWEEP_POLL_S:-2}"
LOG_TAG="classg-sweep-agent"

REQUEST="$STATE_DIR/spectrum-request.json"
BANDS="$STATE_DIR/spectrum-bands.json"
AGENT_STATE="$STATE_DIR/spectrum-agent.json"

log() {
    printf '%s %s\n' "$(date -Is)" "$*"
    logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true
}

# One place that knows whether the radio is ours, so restoring it twice is a
# no-op and restoring it when we never took it does nothing.
DUMP1090_YIELDED=0
restore_radio() {
    [ "$DUMP1090_YIELDED" -eq 1 ] || return 0
    DUMP1090_YIELDED=0
    sudo systemctl start "$DUMP1090_UNIT" 2>/dev/null && log "restarted $DUMP1090_UNIT"
}
trap 'restore_radio; exit 143' TERM
trap 'restore_radio; exit 130' INT
trap 'restore_radio' EXIT

ONESHOT=0
for arg in "$@"; do
    case "$arg" in
        --once) ONESHOT=1 ;;
        -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
    echo "cannot create $STATE_DIR -- is it owned by another user?" >&2
    exit 1
fi

if [ ! -x "$SDR_BIN" ]; then
    echo "no sensor binary at $SDR_BIN" >&2
    echo "build it:  cd $REPO_DIR/services/sensor-sdr && cargo build --release --features rtlsdr" >&2
    exit 1
fi

# The band plan, published once at start. The API reads it rather than keeping
# its own copy of BAND_PLANS, so the two cannot drift.
publish_bands() {
    if "$SDR_BIN" bands --json > "$BANDS.tmp" 2>/dev/null && [ -s "$BANDS.tmp" ]; then
        mv -f "$BANDS.tmp" "$BANDS"
        log "published the band plan"
    else
        rm -f "$BANDS.tmp"
        log "could not read the band plan from $SDR_BIN"
    fi
}

publish_agent_state() {
    printf '{"last_seen_at":"%s","radio_held_by":"%s"}\n' \
        "$(date -Iseconds -u | sed 's/+00:00/Z/')" "${1:-}" > "$AGENT_STATE.tmp" 2>/dev/null
    mv -f "$AGENT_STATE.tmp" "$AGENT_STATE" 2>/dev/null || true
}

write_result() {
    local id="$1" field="$2" payload="$3"
    local out="$STATE_DIR/spectrum-result-$id.json"
    if [ "$field" = "doc" ]; then
        printf '{"id":"%s","doc":%s}\n' "$id" "$payload" > "$out.tmp"
    else
        printf '{"id":"%s","error":"%s"}\n' "$id" \
            "$(printf '%s' "$payload" | tr -d '\r' | tr '\n' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')" > "$out.tmp"
    fi
    # Rename, so the API never reads a half-written result.
    mv -f "$out.tmp" "$out"
}

# json_field pulls one string out of the request without needing jq, which is
# not on a stock Pi OS.
json_field() {
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" <<< "$1" | head -1
}

run_sweep() {
    local id="$1" band="$2"
    log "sweep $id requested for band $band"

    # Yield the radio. dump1090 owns it on a working unit and a sweep cannot
    # share it. The RETURN trap covers the sweep dying or the tune failing
    # halfway; the signal traps above cover systemd stopping the agent while a
    # measurement is in flight.
    if systemctl is-active --quiet "$DUMP1090_UNIT" 2>/dev/null; then
        log "stopping $DUMP1090_UNIT for the sweep -- ADS-B is blind until it returns"
        if sudo systemctl stop "$DUMP1090_UNIT" 2>/dev/null; then
            DUMP1090_YIELDED=1
            publish_agent_state "sweep $id"
            trap restore_radio RETURN
        else
            write_result "$id" error "could not stop $DUMP1090_UNIT to free the radio"
            return
        fi
        # librtlsdr does not release instantly.
        sleep 1
    fi

    local out err
    out=$("$SDR_BIN" sweep --band "$band" --json 2>/tmp/classg-sweep-err.$$)
    local rc=$?
    err=$(tr '\n' ' ' < /tmp/classg-sweep-err.$$ 2>/dev/null | tail -c 400)
    rm -f /tmp/classg-sweep-err.$$

    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
        write_result "$id" doc "$out"
        log "sweep $id completed"
    else
        write_result "$id" error "${err:-the sweep failed with status $rc}"
        log "sweep $id failed: ${err:-status $rc}"
    fi

    publish_agent_state ""
    return 0
}

handle_request() {
    [ -f "$REQUEST" ] || return 0
    local body id band

    # Read, and read again if the first look made no sense.
    #
    # The API writes this by rename now, so a torn read should be impossible --
    # but the API is a container and this is a host script, and they upgrade
    # independently. An older API still writing straight to the path leaves
    # this reading a file mid-write, and the cost of getting that wrong is not
    # small: the request is consumed below whatever happens, so a torn read
    # means the operator watches the spectrum page hang for the full
    # CLASSG_SWEEP_TIMEOUT before being told nothing answered.
    #
    # One retry, a moment later, distinguishes a half-written file from a
    # genuinely malformed one without looping forever on real garbage.
    body=$(cat "$REQUEST" 2>/dev/null)
    id=$(json_field "$body" id)
    band=$(json_field "$body" band)
    if { [ -z "$id" ] || [ -z "$band" ]; } && [ -f "$REQUEST" ]; then
        sleep 0.2
        body=$(cat "$REQUEST" 2>/dev/null)
        id=$(json_field "$body" id)
        band=$(json_field "$body" band)
        [ -n "$id" ] && [ -n "$band" ] &&
            log "the sweep request only parsed on the second read; it was caught mid-write"
    fi

    # Consumed immediately, whatever happens next -- a request that survives a
    # crash would be re-run on the next start, taking the radio for a sweep
    # nobody is waiting for any more.
    rm -f "$REQUEST"

    if [ -z "$id" ] || [ -z "$band" ]; then
        # Says what it saw. "ignoring a malformed sweep request" on its own left
        # nothing to tell a truncated document from a wrong one.
        log "ignoring a malformed sweep request (${#body} bytes, id='${id}', band='${band}')"
        return 0
    fi
    run_sweep "$id" "$band"
}

# Results nobody collected. The API deletes one as soon as it reads it, so
# anything old belongs to a browser that gave up or a container that restarted.
sweep_stale_results() {
    find "$STATE_DIR" -maxdepth 1 -name 'spectrum-result-*.json' -mmin +60 -delete 2>/dev/null || true
}

publish_bands
publish_agent_state ""

if [ "$ONESHOT" -eq 1 ]; then
    handle_request
    exit 0
fi

log "watching for sweep requests every ${POLL_S}s"
while true; do
    handle_request
    sweep_stale_results
    publish_agent_state ""
    sleep "$POLL_S"
done

#!/usr/bin/env bash
# Notice when the stack is broken, and try a bounded, visible repair.
#
# This exists because of a gap the sensor units name themselves. They set
# StartLimitBurst=5 deliberately -- an unbounded Restart=always against a
# physically absent adapter is a loop that burns CPU while looking like
# activity -- and their comment says why nothing better was available:
#
#     systemd 252 (Bookworm) has no RestartSteps/RestartMaxDelaySec, so
#     escalating backoff is not available here; give up visibly instead of
#     backing off blindly.
#
# Giving up visibly is right, and it leaves the unit in `failed` for ever. On a
# reboot where the USB adapter enumerates a few seconds late, five restarts are
# spent in twenty-five seconds and the sensor is dead until a human logs in.
# This is the supervised retry systemd 252 cannot express: escalating backoff,
# a hard ceiling, and a written record of every action.
#
# Three rules it does not break:
#
#   A repair must not hide a fault. Every attempt is recorded and surfaced in
#   the admin page. After the ceiling it STOPS and says the unit needs hands,
#   rather than restarting something broken every two minutes for a week --
#   which is how a dead adapter becomes a mystery instead of a fault.
#
#   Absent hardware is not a software fault. If the radio is not on the USB bus,
#   restarting a process achieves nothing. That is reported and does not consume
#   an attempt, so the escalation ladder is not spent waiting for someone to
#   plug it back in.
#
#   It never interrupts a measurement. Same rule as the deploy agent: a capture
#   or a sweep in progress postpones everything except a completely dead API.

set -uo pipefail

REPO_DIR="${CLASSG_REPO_DIR:-$HOME/classg}"

# Compose only reads the .env in its own project directory (docker/), so a
# repair that recreated containers without these would quietly strip every
# Tier 1 secret the repo-root .env supplies -- Turso credentials, the OIDC
# client secret, the SMTP password -- and "repair" the stack into a
# less-configured state than it was in before. Root last, because a later
# --env-file wins and CLASSG_AGENT_STATE_GID lives only in docker/.env. Each
# is included only if present; compose errors on a missing --env-file.
COMPOSE_ENV_ARGS=()
[ -f "$REPO_DIR/docker/.env" ] && COMPOSE_ENV_ARGS+=(--env-file "$REPO_DIR/docker/.env")
[ -f "$REPO_DIR/.env" ] && COMPOSE_ENV_ARGS+=(--env-file "$REPO_DIR/.env")
API="${CLASSG_PI_API:-http://127.0.0.1:8081}"
# Defaults INSIDE the repo, and that is deliberate. Compose runs from docker/
# and reads docker/.env, not the repo-root .env the systemd units use -- so a
# state directory configured in the root .env is invisible to the container, and
# the mount silently falls back to its own default. Observed on a live unit: the
# agents wrote to ~/.local/state/classg and the API mounted an empty directory,
# and the admin page reported "no agent" with everything working perfectly.
#
# Defaulting both sides to the same repo-relative path means they agree by
# construction, with nothing to configure and nothing to keep in sync.
STATE_DIR="${CLASSG_DEPLOY_STATE:-$REPO_DIR/.agent-state}"
STATE_JSON="$STATE_DIR/watchdog-state.json"
ATTEMPTS_DIR="$STATE_DIR/watchdog-attempts"
LOG_TAG="classg-watchdog"

# The escalation ladder, in seconds. Attempt 1 is immediate; after that the
# minimum wait before trying the same target again. Past the end of the ladder
# the target is left alone and reported as needing attention.
BACKOFF=(0 300 900 3600)
CEILING=${#BACKOFF[@]}

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --reset) rm -rf "${ATTEMPTS_DIR:?}"; echo "escalation state cleared"; exit 0 ;;
        -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

RUN_LOG=""
ACTIONS=0
log() {
    printf '%s %s\n' "$(date -Is)" "$*"
    logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true
    RUN_LOG="$RUN_LOG$*"$'\n'
}

# The state directory must exist and be writable before anything else. Both
# failures below were real on first install: Docker creates a missing
# bind-mount source as root, so the agent -- which runs as an ordinary user --
# could not write to the directory the container had just made for it.
if ! mkdir -p "$STATE_DIR" "$ATTEMPTS_DIR" 2>/dev/null; then
    echo "cannot create $STATE_DIR -- is it owned by another user? " \
        "(docker creates a missing bind-mount source as root)" >&2
    exit 1
fi

# Opening the lock is checked SEPARATELY from taking it, and that distinction is
# the whole point. When `exec 9>` failed on a root-owned directory, fd 9 was
# never opened, `flock -n 9` failed with "Bad file descriptor", and the code
# below read that as ordinary contention and skipped the pass -- quietly, for
# ever. A watchdog that silently never runs is worse than no watchdog, because
# the admin page keeps reporting its last successful pass.
if ! : >>"$STATE_DIR/agent.lock" 2>/dev/null; then
    echo "cannot write $STATE_DIR/agent.lock -- check ownership of $STATE_DIR" >&2
    exit 1
fi

# One agent at a time. The watchdog and the deploy agent both run `docker
# compose up` on the same project, and they run on independent timers -- so
# without this, a deploy that takes the API down for a rebuild looks like a
# fault to the watchdog, which "repairs" it by racing a second compose against
# the first. Observed while installing both on a live unit: the deploy was
# mid-rebuild and the watchdog was two minutes from firing at it.
#
# flock rather than a PID file: the lock dies with the process, so a killed
# agent cannot leave the other one blocked for ever.
#
# Waits rather than skipping outright, for the reason written up in
# pi-autodeploy.sh: `flock -n` turned an overlap of a few seconds into a lost
# cycle, invisibly. The asymmetry here is deliberate -- a deploy legitimately
# holds this lock for minutes, and a watchdog that queued behind one would be
# checking the health of a stack that is mid-rebuild. So it waits a short time
# for an overlap and otherwise stands down, which is also the correct
# behaviour: a deploy in progress is not a fault to repair.
LOCK_WAIT="${CLASSG_LOCK_WAIT:-20}"
exec 9>"$STATE_DIR/agent.lock"
if ! flock -w "$LOCK_WAIT" 9; then
    log "another ClassG agent still holds the lock after ${LOCK_WAIT}s; standing down this pass"
    exit 0
fi

json_escape() {
    printf '%s' "$1" | tr -d '\r' | tr '\t' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

json_log_array() {
    local first=1 line
    printf '['
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        [ "$first" -eq 0 ] && printf ', '
        printf '"%s"' "$(json_escape "$line")"
        first=0
    done <<< "$(printf '%s' "$RUN_LOG" | tail -40)"
    printf ']'
}

# --- escalation bookkeeping -------------------------------------------------
#
# One file per target holding "attempts last_attempt_epoch". Files rather than a
# single document so a crashed run cannot corrupt the whole ladder, and so
# `--reset` is an rm.

attempts_of() { cut -d' ' -f1 < "$ATTEMPTS_DIR/$1" 2>/dev/null || echo 0; }
last_try_of() { cut -d' ' -f2 < "$ATTEMPTS_DIR/$1" 2>/dev/null || echo 0; }

record_attempt() {
    local target="$1" n
    n=$(( $(attempts_of "$target") + 1 ))
    printf '%s %s\n' "$n" "$(date +%s)" > "$ATTEMPTS_DIR/$target"
}

# clear_target forgets a target's history once it is healthy again, so a unit
# that recovers gets the full ladder next time rather than starting at the top.
clear_target() {
    if [ -f "$ATTEMPTS_DIR/$1" ]; then
        log "$1 is healthy again; clearing its repair history"
        rm -f "$ATTEMPTS_DIR/$1"
    fi
}

# may_try reports whether the ladder allows another attempt on this target now.
may_try() {
    local target="$1" n waited since
    n=$(attempts_of "$target")
    if [ "$n" -ge "$CEILING" ]; then
        return 1
    fi
    waited=${BACKOFF[$n]}
    since=$(( $(date +%s) - $(last_try_of "$target") ))
    [ "$since" -ge "$waited" ]
}

# --- probes -----------------------------------------------------------------

api_ok() { curl -fsS --max-time 5 "$API/api/v1/health" >/dev/null 2>&1; }

busy_reason() {
    local body
    body=$(curl -sS --max-time 5 "$API/api/v1/captures" 2>/dev/null) || return 0
    case "$body" in *'"state":"running"'*) echo "a capture is running"; return 0 ;; esac
    body=$(curl -sS --max-time 5 "$API/api/v1/spectrum/sweeps" 2>/dev/null) || return 0
    case "$body" in *'"state":"running"'*) echo "a band sweep is running"; return 0 ;; esac
    return 0
}

# wifi_adapter_present asks the kernel, not the sensor. An adapter that is not
# on the bus is not a software fault and restarting a process cannot help.
wifi_adapter_present() { [ -d /sys/class/net/"$1" ]; }

sdr_present() { lsusb 2>/dev/null | grep -qiE "rtl2838|realtek.*2838|0bda:2838"; }

unit_failed() { systemctl is-failed --quiet "$1" 2>/dev/null; }
unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
unit_enabled() { systemctl is-enabled --quiet "$1" 2>/dev/null; }

# --- repairs ----------------------------------------------------------------

# repair_unit is the whole point: reset-failed is what un-sticks a unit that
# exhausted StartLimitBurst. Without it `systemctl restart` on a failed unit
# does nothing at all, which is the single most confusing way for this to
# appear not to work.
repair_unit() {
    local unit="$1" why="$2"
    local n
    n=$(( $(attempts_of "$unit") + 1 ))

    if [ "$DRY_RUN" -eq 1 ]; then
        log "would repair $unit ($why) -- attempt $n of $CEILING"
        return 0
    fi

    log "repairing $unit ($why) -- attempt $n of $CEILING"
    record_attempt "$unit"
    ACTIONS=$((ACTIONS + 1))

    systemctl reset-failed "$unit" 2>/dev/null || true
    if sudo systemctl restart "$unit" 2>&1 | while read -r l; do log "  $l"; done; then
        sleep 5
        if unit_active "$unit"; then
            log "$unit is running again"
        else
            log "$unit did not come back"
        fi
    else
        log "restarting $unit failed"
    fi
}

repair_web_tier() {
    local n
    n=$(( $(attempts_of "web-tier") + 1 ))
    if [ "$DRY_RUN" -eq 1 ]; then
        log "would restart the web tier -- attempt $n of $CEILING"
        return 0
    fi
    log "the API is not answering; restarting the web tier -- attempt $n of $CEILING"
    record_attempt "web-tier"
    ACTIONS=$((ACTIONS + 1))
    (cd "$REPO_DIR/docker" && docker compose ${COMPOSE_ENV_ARGS[@]+"${COMPOSE_ENV_ARGS[@]}"} up -d 2>&1 | tail -5 |
        while read -r l; do log "  $l"; done)
}

# --- the pass ---------------------------------------------------------------

NEEDS_HANDS=""
# For a target that HAS been retried up the ladder and is now out of attempts.
note_needs_hands() {
    NEEDS_HANDS="$NEEDS_HANDS$1; "
    log "GIVING UP on $1 -- $CEILING attempts made, this needs hands"
}

# For something that was never retried because retrying is not the fix -- a
# privileged install step the agent deliberately cannot take. Claiming attempts
# were made would be a lie, and the caller has already said what is wrong.
note_needs_hands_only() {
    NEEDS_HANDS="$NEEDS_HANDS$1; "
}

repair_wifi() {
    local unit="$1" iface="$2"
    if ! wifi_adapter_present "$iface"; then
        log "$iface is not on the bus; this is hardware, not software -- not restarting $unit"
    elif unit_failed "$unit"; then
        if may_try "$unit"; then
            repair_unit "$unit" "the unit is in failed state"
        elif [ "$(attempts_of "$unit")" -ge "$CEILING" ]; then
            note_needs_hands "$unit"
        else
            log "$unit is failed; waiting out the backoff"
        fi
    elif ! unit_active "$unit"; then
        if may_try "$unit"; then
            repair_unit "$unit" "the unit is not running"
        fi
    else
        clear_target "$unit"
    fi
}

# The API first. Everything else is diagnosed through it, and a dead API makes
# every sensor look broken.
if api_ok; then
    clear_target "web-tier"
else
    if may_try "web-tier"; then
        repair_web_tier
    elif [ "$(attempts_of web-tier)" -ge "$CEILING" ]; then
        note_needs_hands "the API (web tier)"
    else
        log "the API is down; waiting out the backoff before trying again"
    fi
fi

BUSY=$(busy_reason)
if [ -n "$BUSY" ]; then
    log "postponing sensor repairs: $BUSY"
else
    # Wi-Fi. The primary Alfa is required. The TP-Link sweep receiver is only
    # watched when its unit is enabled, so deployments without it stay quiet.
    repair_wifi classg-sensor-wifi.service "${CLASSG_WIFI_IFACE:-wlan-alfa}"
    if unit_enabled classg-sensor-wifi-tplink.service; then
        repair_wifi classg-sensor-wifi-tplink.service "${CLASSG_WIFI_TPLINK_IFACE:-wlan-tplink}"
    fi

    # SDR. dump1090 owns the radio, so an absent dongle is dump1090's problem
    # and this sensor correctly reports itself degraded rather than failing --
    # restarting it would achieve nothing.
    SDR_UNIT=classg-sensor-sdr.service
    if unit_failed "$SDR_UNIT"; then
        if may_try "$SDR_UNIT"; then
            repair_unit "$SDR_UNIT" "the unit is in failed state"
        elif [ "$(attempts_of "$SDR_UNIT")" -ge "$CEILING" ]; then
            note_needs_hands "$SDR_UNIT"
        else
            log "$SDR_UNIT is failed; waiting out the backoff"
        fi
    elif ! unit_active "$SDR_UNIT"; then
        if may_try "$SDR_UNIT"; then
            repair_unit "$SDR_UNIT" "the unit is not running"
        fi
    else
        clear_target "$SDR_UNIT"
        if ! sdr_present; then
            log "classg-sensor-sdr is running but no RTL-SDR is on the USB bus; ADS-B will read degraded"
        fi
    fi
fi

# Unit files are the one thing a deploy cannot install for you: pi-autodeploy
# rebuilds containers and restarts services, but installing a systemd unit needs
# root, and the deploy agent's sudo is deliberately narrow enough that it cannot.
# So a change to deploy/systemd/ sits in the checkout doing nothing, silently,
# until somebody runs install.sh -- which is how this unit ran an SDR sensor
# with none of its sandboxing for a day while the template beside it had all of
# it. Reported, never acted on: this is a "needs hands" by construction.
check_unit_drift() {
    local tpl unit rendered runas iface
    [ -d "$REPO_DIR/deploy/systemd" ] || return 0
    runas="$(stat -c %U "$REPO_DIR" 2>/dev/null)" || return 0
    iface="${CLASSG_WIFI_IFACE:-wlan-alfa}"
    for tpl in "$REPO_DIR"/deploy/systemd/*.service.in; do
        [ -e "$tpl" ] || continue
        unit="$(basename "$tpl" .in)"
        # Only units this box actually has installed; an optional companion
        # receiver that was never installed is not drift.
        [ -f "/etc/systemd/system/$unit" ] || continue
        rendered="$(sed -e "s|@CLASSG_HOME@|$REPO_DIR|g" -e "s|@IFACE@|$iface|g"             -e "s|@RUNAS@|$runas|g" "$tpl" 2>/dev/null)" || continue
        if ! printf '%s
' "$rendered" | diff -q - "/etc/systemd/system/$unit" >/dev/null 2>&1; then
            log "$unit differs from its template; run sudo ./deploy/systemd/install.sh"
            note_needs_hands_only "$unit is out of date (run deploy/systemd/install.sh)"
        fi
    done
}
check_unit_drift

# The same class of drift, one directory over. The agents restart sensor units
# through narrow NOPASSWD grants, and those grants are written by the installers
# -- so a unit added later (the companion receiver was) has no grant until
# somebody re-runs them. The deploy then fails on a sudo password prompt it
# cannot answer, mid-deploy, having already restarted the other sensors.
# Observed exactly that: "sudo: a password is required" while the tplink
# receiver went un-restarted and the deploy still reported success.
check_sudoers_drift() {
    local grants unit
    grants="$(sudo -n -l 2>/dev/null)" || return 0
    for unit in classg-sensor-wifi classg-sensor-sdr classg-sensor-wifi-tplink; do
        [ -f "/etc/systemd/system/$unit.service" ] || continue
        if ! printf '%s' "$grants" | grep -q "NOPASSWD.*restart $unit.service"; then
            log "no passwordless restart grant for $unit.service; the agents cannot restart it"
            note_needs_hands_only "$unit.service has no sudo grant (re-run scripts/install-watchdog.sh and install-autodeploy.sh)"
        fi
    done
}
check_sudoers_drift

[ "$ACTIONS" -eq 0 ] && [ -z "$NEEDS_HANDS" ] && log "nothing to repair"

# --- publish ----------------------------------------------------------------

{
    printf '{\n'
    printf '  "last_check_at": "%s",\n' "$(date -Iseconds -u | sed 's/+00:00/Z/')"
    printf '  "actions_taken": %s,\n' "$ACTIONS"
    printf '  "needs_hands": "%s",\n' "$(json_escape "${NEEDS_HANDS%%; }")"
    printf '  "api_healthy": %s,\n' "$(api_ok && echo true || echo false)"
    printf '  "wifi_adapter_present": %s,\n' "$(wifi_adapter_present "${CLASSG_WIFI_IFACE:-wlan-alfa}" && echo true || echo false)"
    printf '  "wifi_tplink_adapter_present": %s,\n' "$(wifi_adapter_present "${CLASSG_WIFI_TPLINK_IFACE:-wlan-tplink}" && echo true || echo false)"
    printf '  "sdr_present": %s,\n' "$(sdr_present && echo true || echo false)"
    printf '  "log": %s\n' "$(json_log_array)"
    printf '}\n'
} > "$STATE_JSON.tmp" 2>/dev/null
mv -f "$STATE_JSON.tmp" "$STATE_JSON" 2>/dev/null || true

exit 0

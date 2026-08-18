#!/usr/bin/env bash
# Pull main onto this unit, but only when CI says it is good.
#
# Pull-based, running ON the Pi, rather than a push from GitHub Actions. Three
# reasons, in order of how much they matter:
#
#   - No inbound credentials. GitHub never needs a key to this box, and this box
#     needs no public ingress. A push-based deploy means one or the other.
#   - It catches up. A unit that was powered off, or off the tailnet, or in a
#     field with no signal, deploys the next time it looks -- a webhook fired
#     into the void is simply lost.
#   - It is debuggable from the unit. `pi-autodeploy.sh --once` here tells you
#     exactly what a deploy would do; a remote runner tells you afterwards.
#
# The CI gate is the point. This deploys a commit only when the CI run for that
# exact SHA concluded success -- never on "it is newer", because main can be red
# and a unit that deploys red main is a unit that stops detecting for reasons
# nobody chose.
#
# Deploying stops detection for as long as the rebuild takes. That cost is real,
# so this refuses to start while a capture or a sweep is running: taking the
# radio away from an operator mid-measurement to install a UI change is not a
# trade anything here gets to make on their behalf.

set -uo pipefail

REPO_DIR="${CLASSG_REPO_DIR:-$HOME/classg}"
BRANCH="${CLASSG_DEPLOY_BRANCH:-main}"
API="${CLASSG_PI_API:-http://127.0.0.1:8081}"
GH_REPO="${CLASSG_GH_REPO:-lnorton89/classg}"
# See the same constant in classg-watchdog.sh: compose cannot read the repo-root
# .env, so both sides default to one repo-relative path and agree by
# construction rather than by configuration.
STATE_DIR="${CLASSG_DEPLOY_STATE:-$REPO_DIR/.agent-state}"
LOG_TAG="classg-autodeploy"

# rustup installs into ~/.cargo/bin, which is on an interactive shell's PATH via
# a line in .bashrc and on a systemd unit's PATH via nothing at all. Without
# this, `cargo build` under the timer fails with "command not found", the SDR
# sensor step sets DEPLOY_OK=0, and a deploy that was otherwise fine rolls
# itself back -- reporting a build failure for a compiler it never found.
CARGO_BIN="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}/.cargo/bin"
case ":$PATH:" in
    *":$CARGO_BIN:"*) ;;
    *) [ -d "$CARGO_BIN" ] && PATH="$CARGO_BIN:$PATH" ;;
esac
export PATH
STATE_JSON="$STATE_DIR/deploy-state.json"
REQUEST_FILE="$STATE_DIR/deploy-requested"

DRY_RUN=0
FORCE=0
SKIP_CI=0
for arg in "$@"; do
    case "$arg" in
        --once) ;;                    # the default; accepted for readability
        --dry-run) DRY_RUN=1 ;;
        --force) FORCE=1 ;;
        # Deploys a commit CI has not blessed. For recovering a unit when
        # GitHub is unreachable and you have decided the risk yourself.
        --skip-ci-check) SKIP_CI=1 ;;
        -h|--help)
            sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

# RUN_LOG accumulates the tail the admin page shows. The API cannot read the
# host journal from inside its container, so the log has to come to it.
RUN_LOG=""
log() {
    printf '%s %s\n' "$(date -Is)" "$*"
    logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true
    RUN_LOG="$RUN_LOG$*"$'\n'
}
die() { log "FAILED: $*"; write_state "failed" "$*"; exit 1; }

# run_logged DIR TAIL_LINES -- COMMAND...
#
# Runs a command in DIR, keeps the last TAIL_LINES of its combined output in
# RUN_LOG, and returns the command's own exit status.
#
# Through a temp file rather than the obvious `cmd 2>&1 | while read; do log;
# done`, which is what this replaces and which silently threw every line away:
# the right-hand side of a pipe is a SUBSHELL, so each `log` appended to that
# subshell's copy of RUN_LOG and the copy died with it. The console and the
# journal still got the lines -- `log` prints and calls logger before it
# appends -- so this looked fine from a terminal while making the admin page's
# log useless for the one job it has.
#
# It cost a real diagnosis. A deploy failed reporting `pip install failed` with
# not one line of pip's output to say why, on a unit with no shell access.
#
# The pipe hid failures a second way too: `a | b` reports b's status, so a
# command that died still looked successful whenever `while read` finished
# cleanly -- which it always does.
run_logged() {
    local dir="$1" tail_lines="$2"; shift 2
    [ "${1:-}" = "--" ] && shift

    local out status
    if ! out=$(mktemp); then
        log "could not make a temp file; running this step unlogged"
        ( cd "$dir" && "$@" )
        return $?
    fi

    ( cd "$dir" && "$@" ) > "$out" 2>&1
    status=$?
    while IFS= read -r line; do
        [ -n "$line" ] && log "  $line"
    done < <(tail -n "$tail_lines" "$out")
    rm -f "$out"
    return "$status"
}

# json_escape handles one line. Enough for what this writes -- log lines, commit
# subjects, reasons -- and deliberately not a general escaper: backslash, quote,
# and the control characters that actually turn up.
json_escape() {
    printf '%s' "$1" | tr -d '\r' | tr '\t' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# json_log_array renders RUN_LOG as a JSON array, one element per line.
#
# Built with a loop rather than a sed pipeline. The pipeline version produced
# [""] on a real run, which is the kind of bug that only shows up once the thing
# is deployed and someone is looking at an empty log wondering what happened.
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

# ARTEFACTS records what rebuild_stale_artefacts found, so the state file can
# say "pi-dash: current" rather than leaving an operator to infer it from the
# absence of a log line. That inference is exactly what went wrong: a run that
# never checked and a run that checked and found nothing look identical in a
# log that only speaks when it acts.
#
# Empty on the paths that deliberately do not check (busy unit, dirty tree), and
# the field is then absent rather than claiming everything is fine.
ARTEFACTS=""

# FAILED_STEP is the first build step that failed, kept so the rollback can say
# what actually went wrong.
#
# It used to say "the unit did not come back healthy" whichever step broke,
# which sent me looking at an API that was answering perfectly well while the
# real fault was a pip install four steps earlier. A reason that names the
# wrong subsystem is worse than no reason.
FAILED_STEP=""

# When this run began, for the history's duration figure.
RUN_STARTED_AT=$(date -Iseconds -u | sed 's/+00:00/Z/')
RUN_STARTED_EPOCH=$(date +%s)

fail_step() {
    log "$1"
    [ -z "$FAILED_STEP" ] && FAILED_STEP="$1"
}

note_artefact() {
    [ -n "$ARTEFACTS" ] && ARTEFACTS="$ARTEFACTS, "
    ARTEFACTS="$ARTEFACTS{\"name\": \"$1\", \"state\": \"$2\"}"
}

# write_state publishes what just happened, for GET /admin/deployment.
#
# Written to a temp file and renamed, so the API never reads a half-written
# document. rename(2) within a directory is atomic; a plain redirect is not.
write_state() {
    local result="$1" reason="${2:-}"
    local head remote subject commit_at timer_enabled ci
    head=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")
    remote=$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH" 2>/dev/null || echo "")
    subject=$(git -C "$REPO_DIR" log -1 --pretty=%s 2>/dev/null || echo "")
    commit_at=$(git -C "$REPO_DIR" log -1 --pretty=%cI 2>/dev/null || echo "")
    ci="${REMOTE_CI:-unknown}"
    if systemctl is-enabled --quiet classg-autodeploy.timer 2>/dev/null; then
        timer_enabled=true
    else
        timer_enabled=false
    fi

    # The last deploy is carried forward from a file rather than from this
    # run's variables, which are only set on the run that actually deployed.
    # Without this every later check -- "up to date", "blocked", one every ten
    # minutes -- wrote a state document with no deploy fields at all, and the
    # admin page read that as "Last deploy: never" on a unit that had deployed
    # twenty minutes earlier.
    local d_at="${DEPLOY_AT:-}" d_commit="${DEPLOY_COMMIT:-}" d_ok="${DEPLOY_OK_JSON:-}"
    if [ -n "$d_at" ]; then
        printf '%s\n%s\n%s\n' "$d_at" "$d_commit" "${d_ok:-false}" \
            > "$STATE_DIR/last-deploy" 2>/dev/null || true
    elif [ -r "$STATE_DIR/last-deploy" ]; then
        { read -r d_at; read -r d_commit; read -r d_ok; } < "$STATE_DIR/last-deploy"
    fi

    mkdir -p "$STATE_DIR"
    {
        printf '{\n'
        printf '  "commit": "%s",\n' "$head"
        printf '  "commit_subject": "%s",\n' "$(json_escape "$subject")"
        [ -n "$commit_at" ] && printf '  "commit_at": "%s",\n' "$commit_at"
        printf '  "last_check_at": "%s",\n' "$(date -Iseconds -u | sed 's/+00:00/Z/')"
        printf '  "last_result": "%s",\n' "$result"
        printf '  "last_reason": "%s",\n' "$(json_escape "$reason")"
        [ -n "$d_at" ] && printf '  "last_deploy_at": "%s",\n' "$d_at"
        [ -n "$d_commit" ] && printf '  "last_deploy_commit": "%s",\n' "$d_commit"
        printf '  "last_deploy_ok": %s,\n' "${d_ok:-false}"
        printf '  "remote_commit": "%s",\n' "$remote"
        printf '  "remote_ci": "%s",\n' "$ci"
        printf '  "timer_enabled": %s,\n' "$timer_enabled"
        [ -n "$ARTEFACTS" ] && printf '  "artefacts": [%s],\n' "$ARTEFACTS"
        printf '  "log": %s\n' "$(json_log_array)"
        printf '}\n'
    } > "$STATE_JSON.tmp" 2>/dev/null
    mv -f "$STATE_JSON.tmp" "$STATE_JSON" 2>/dev/null || true

    append_history "$result" "$reason" "$head" "$subject"
}

# HISTORY_MAX runs are kept. Fifty is weeks of a ten-minute timer, because only
# runs that DID something are recorded -- an idle unit adds nothing.
HISTORY_MAX=50

# append_history records one finished run, for the deploy list in the admin page.
#
# Only results that represent work: deployed, failed, rebuilt. A timer that
# fires every ten minutes and finds nothing to do would otherwise bury the six
# real deploys of a week under a thousand rows of "up to date" -- and the point
# of the list is being able to find the deploy that broke something.
#
# JSON Lines rather than one document: appending a line is atomic enough for a
# single writer, where rewriting a growing array means a read-modify-write that
# can be interrupted halfway and lose everything before it.
append_history() {
    local result="$1" reason="$2" head="$3" subject="$4"
    case "$result" in
        deployed|failed|rebuilt) ;;
        *) return 0 ;;
    esac

    local finished duration entry file
    finished=$(date -Iseconds -u | sed 's/+00:00/Z/')
    duration=$(( $(date +%s) - RUN_STARTED_EPOCH ))
    file="$STATE_DIR/deploy-history.jsonl"

    entry=$(
        printf '{'
        printf '"id": "%s-%s", ' "$RUN_STARTED_EPOCH" "${head:0:8}"
        printf '"started_at": "%s", ' "$RUN_STARTED_AT"
        printf '"finished_at": "%s", ' "$finished"
        printf '"duration_s": %s, ' "$duration"
        printf '"result": "%s", ' "$result"
        printf '"reason": "%s", ' "$(json_escape "$reason")"
        printf '"commit": "%s", ' "$head"
        printf '"commit_subject": "%s", ' "$(json_escape "$subject")"
        printf '"previous_commit": "%s", ' "${LOCAL:-}"
        [ -n "$ARTEFACTS" ] && printf '"artefacts": [%s], ' "$ARTEFACTS"
        printf '"log": %s' "$(json_log_array)"
        printf '}'
    )

    printf '%s\n' "$entry" >> "$file" 2>/dev/null || return 0

    # Trim in place, oldest first. Through a temp file and a rename so a reader
    # never sees a half-written history.
    if [ "$(wc -l < "$file" 2>/dev/null || echo 0)" -gt "$HISTORY_MAX" ]; then
        if tail -n "$HISTORY_MAX" "$file" > "$file.tmp" 2>/dev/null; then
            mv -f "$file.tmp" "$file" 2>/dev/null || true
        fi
    fi
}

# The state directory must exist and be writable before anything else. Both
# failures below were real on first install: Docker creates a missing
# bind-mount source as root, so the agent -- which runs as an ordinary user --
# could not write to the directory the container had just made for it.
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
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
exec 9>"$STATE_DIR/agent.lock"
if ! flock -n 9; then
    log "another ClassG agent is already running; skipping this pass"
    exit 0
fi

[ -d "$REPO_DIR/.git" ] || die "no git checkout at $REPO_DIR (set CLASSG_REPO_DIR)"
cd "$REPO_DIR" || die "cannot enter $REPO_DIR"

# --- is anything in progress that a restart would ruin? ---------------------
#
# Checked before fetching, so the common "nothing to do" case is one HTTP call
# and no network round trip to GitHub.
busy_reason() {
    local body
    body=$(curl -sS --max-time 10 "$API/api/v1/captures" 2>/dev/null) || return 0
    case "$body" in *'"state":"running"'*) echo "a capture is running"; return 0 ;; esac
    body=$(curl -sS --max-time 10 "$API/api/v1/spectrum/sweeps" 2>/dev/null) || return 0
    case "$body" in *'"state":"running"'*) echo "a band sweep is running"; return 0 ;; esac
    return 0
}

# --- what is upstream? ------------------------------------------------------
git fetch --quiet origin "$BRANCH" || die "git fetch failed"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

# A deploy requested from the admin page. The API cannot run anything on this
# host -- it writes this marker and we pick it up. Consumed here whatever
# happens next, so a request that is refused does not retry forever.
if [ -f "$REQUEST_FILE" ]; then
    log "a deploy was requested from the admin page: $(tr '\n' ' ' < "$REQUEST_FILE")"
    rm -f "$REQUEST_FILE"
    FORCE=1
fi

# Is a release binary older than the sources it was built from?
#
# Change detection compares the SHA before the merge with the SHA after, which
# is exactly wrong once somebody has merged by hand on the box: the tree is
# current, LOCAL == REMOTE, this script reports "up to date", and the release
# binary is still whatever was built days ago. Not hypothetical -- this unit ran
# a classg-sensor-sdr that predated the `bands` and `sweep` subcommands for two
# days while every deploy run called itself current, because the commits that
# added them arrived through a manual merge rather than through here.
#
# Comparing the artefact against its inputs catches that; comparing two SHAs
# never can. Mtimes are good enough for the question being asked -- a rebuild
# that was not needed costs minutes, a missed one costs a feature that silently
# is not there.
stale_bin() {
    local bin="$1"
    shift
    [ -x "$bin" ] || return 0
    [ -n "$(find "$@" -newer "$bin" -print -quit 2>/dev/null)" ]
}

# Stop a successful build that produced no new binary from looping forever.
#
# cargo decides freshness from its own fingerprints, not from the mtime of the
# final binary, so it can legitimately print "Finished" and relink nothing --
# a target directory restored from a backup, or a source file whose mtime moved
# without its content changing. The binary then stays older than its sources,
# stale_bin stays true, and every timer tick rebuilds and RESTARTS THE SENSOR:
# an ADS-B outage every ten minutes for a build that is already correct.
#
# Touching it once, and saying so, converts that into one log line.
settle_artefact() {
    local bin="$1"
    shift
    if stale_bin "$bin" "$@"; then
        log "  cargo considered the build current; stamping $(basename "$bin") so this does not repeat"
        touch "$bin" 2>/dev/null || true
    fi
}

# Rebuild whatever is older than its own sources, whatever git says.
#
# This runs on BOTH paths, and that is the entire point of it existing. The
# staleness checks used to live below the up-to-date exit, so they only ever
# ran when there was a commit to pull -- which is exactly backwards. A unit
# that is current with a stale binary is the COMMON case: the tree stops
# moving, every run reports "up to date", and the artefact somebody is actually
# running stays whatever it was. pi-dash sat at an old build for days that way.
#
# Returns 0 if it rebuilt anything, so the caller can say so rather than
# reporting a run that did work as a run that did nothing.
rebuild_stale_artefacts() {
    local did=1

    local sdr="$REPO_DIR/services/sensor-sdr"
    local sdr_bin="$sdr/target/release/classg-sensor-sdr"
    if stale_bin "$sdr_bin" "$sdr/src" "$sdr/Cargo.toml" "$sdr/Cargo.lock"; then
        log "the SDR sensor binary is older than its sources; rebuilding"
        if run_logged "$sdr" 5 -- cargo build --release --features rtlsdr; then
            settle_artefact "$sdr_bin" "$sdr/src" "$sdr/Cargo.toml" "$sdr/Cargo.lock"
            sudo systemctl restart classg-sensor-sdr.service && log "classg-sensor-sdr restarted"
            note_artefact "classg-sensor-sdr" "rebuilt"
            did=0
        else
            log "cargo build failed; leaving the running binary in place"
            note_artefact "classg-sensor-sdr" "failed"
        fi
    else
        note_artefact "classg-sensor-sdr" "current"
    fi

    if rebuild_pidash_if_stale; then
        did=0
    fi

    return "$did"
}

# pi-dash, which is a submodule and therefore has two ways to be out of date.
#
# The checkout can differ from the pin -- `git submodule status` marks that with
# a leading '+', and it happens whenever a merge moved the pointer and nothing
# ran `submodule update`. Or the pin and checkout can agree while the BINARY
# predates them, which is what happens when the pin moved in a deploy whose
# build step failed, or was bumped by hand.
#
# The `pidash` wrapper on PATH execs this checkout's release build directly, so
# a rebuild is the whole deploy; there is no service to restart. It runs
# interactively, so an operator with it open keeps the old binary until they
# quit and relaunch -- correct behaviour for a dashboard somebody is reading.
rebuild_pidash_if_stale() {
    local dir="$REPO_DIR/tools/pi-dash"
    local bin="$dir/target/release/pi-dash"
    if [ ! -d "$dir" ]; then
        note_artefact "pi-dash" "absent"
        return 1
    fi

    local reason=""
    # A leading '+' means the checkout is not at the pinned commit; '-' means
    # it was never initialised at all.
    case "$(git -C "$REPO_DIR" submodule status tools/pi-dash 2>/dev/null)" in
        "+"*) reason="the checkout is not at the pinned commit" ;;
        "-"*) reason="the submodule was never initialised" ;;
    esac
    if [ -n "$reason" ]; then
        log "updating the pi-dash submodule: $reason"
        run_logged "$REPO_DIR" 10 -- \
            git submodule update --init --recursive tools/pi-dash || true
    fi

    if [ -z "$reason" ] && ! stale_bin "$bin" "$dir/src" "$dir/Cargo.toml"; then
        note_artefact "pi-dash" "current"
        return 1
    fi

    log "rebuilding pi-dash"
    if run_logged "$dir" 3 -- cargo build --release; then
        settle_artefact "$bin" "$dir/src" "$dir/Cargo.toml"
        log "pi-dash rebuilt; a running instance picks it up on next launch"
        note_artefact "pi-dash" "rebuilt"
        return 0
    fi
    note_artefact "pi-dash" "failed"
    # Not fatal anywhere. pi-dash is an operator convenience, and failing a
    # deploy -- rolling back a working detector -- because a dashboard would
    # not compile is the wrong trade.
    log "pi-dash failed to build; everything else stands"
    return 1
}

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" -eq 0 ]; then
    # A dry run says what it WOULD do. The staleness check below rebuilds and
    # restarts a sensor, which is not a thing --dry-run may do -- and it sits
    # above the general dry-run guard further down, so it needs its own.
    if [ "$DRY_RUN" -eq 1 ]; then
        log "dry run: up to date at ${LOCAL:0:8}; not checking build artefacts"
        exit 0
    fi
    # Current on git, which says nothing about what is BUILT. Checked before
    # reporting, because "up to date" over a stale binary is the report that
    # let pi-dash sit at an old version through days of green deploys.
    if rebuild_stale_artefacts; then
        log "up to date at ${LOCAL:0:8}, after rebuilding what had gone stale"
        write_state "rebuilt" "the tree was current but a build artefact was not"
    else
        log "up to date at ${LOCAL:0:8}"
        write_state "up-to-date" ""
    fi
    exit 0
fi

# Never discard local work. A dirty tree on a field unit is usually someone
# mid-diagnosis, and `git pull` would either fail confusingly or clobber it.
# Refusing and saying which files is the only safe answer.
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
    log "refusing to deploy: $REPO_DIR has uncommitted changes"
    printf '%s\n' "$DIRTY" | while read -r line; do log "  $line"; done
    write_state "blocked" "the working tree has uncommitted changes"
    exit 1
fi

log "main is at ${REMOTE:0:8}, this unit is at ${LOCAL:0:8}"

# Exit without deploying, having first checked what is BUILT.
#
# This unit spends most of its life on one of these paths: main has moved, CI
# has not finished, and nothing will be pulled for another ten minutes. That is
# exactly when a stale artefact goes unnoticed -- the run reports "blocked",
# says nothing about the binary, and the operator sees a deploy agent that
# looks busy and is achieving nothing. pi-dash sat at an old build through days
# of these.
#
# Not used for the busy or dirty-tree exits, deliberately. A rebuild restarts
# the sensor, and refusing to disturb a capture in progress or somebody's
# half-finished diagnosis is the whole reason those exits exist.
blocked_exit() {
    local reason="$1"
    # A dry run says what it would do. The rebuild below is real work, and the
    # general dry-run guard sits further down than the CI gate that calls this.
    if [ "$DRY_RUN" -eq 1 ]; then
        log "dry run: $reason; not checking build artefacts"
        exit 0
    fi
    if rebuild_stale_artefacts; then
        log "rebuilt a stale build artefact while waiting"
        write_state "rebuilt" "$reason, and a build artefact was older than its sources"
    else
        write_state "blocked" "$reason"
    fi
    exit 0
}

# --- did CI pass for that exact commit? -------------------------------------
#
# The check-runs conclusion for the SHA, not "is main newer". Deploying a red
# commit is how a unit stops detecting for a reason nobody chose.
if [ "$SKIP_CI" -eq 1 ]; then
    log "WARNING: skipping the CI check by request"
else
    STATUS_JSON=$(curl -sS --max-time 20 \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$GH_REPO/commits/$REMOTE/check-runs" 2>/dev/null)

    REMOTE_CI="unknown"
    if [ -z "$STATUS_JSON" ]; then
        # Unreachable GitHub is not a reason to deploy blind. The unit keeps
        # running what it has, which is a commit that was green when it landed.
        log "could not reach the GitHub API; leaving this unit on ${LOCAL:0:8}"
        blocked_exit "the GitHub API is unreachable, so CI could not be checked"
    fi

    TOTAL=$(printf '%s' "$STATUS_JSON" | grep -o '"total_count"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
    TOTAL=${TOTAL:-0}
    if [ "$TOTAL" -eq 0 ]; then
        REMOTE_CI="pending"
        log "no CI runs recorded for ${REMOTE:0:8} yet; will look again next time"
        blocked_exit "no CI runs recorded for this commit yet"
    fi

    # Any run still going means "not yet", not "fine".
    if printf '%s' "$STATUS_JSON" | grep -q '"status"[[:space:]]*:[[:space:]]*"\(queued\|in_progress\)"'; then
        REMOTE_CI="pending"
        log "CI is still running for ${REMOTE:0:8}; will look again next time"
        blocked_exit "CI is still running for this commit"
    fi
    # Any conclusion that is not success blocks. Listing them explicitly rather
    # than negating "success" means a conclusion GitHub adds later fails closed.
    if printf '%s' "$STATUS_JSON" | grep -q '"conclusion"[[:space:]]*:[[:space:]]*"\(failure\|cancelled\|timed_out\|action_required\|stale\)"'; then
        REMOTE_CI="failure"
        log "CI is not green for ${REMOTE:0:8}; leaving this unit on ${LOCAL:0:8}"
        blocked_exit "CI is not green for this commit"
    fi
    REMOTE_CI="success"
    log "CI is green for ${REMOTE:0:8}"
fi

BUSY=$(busy_reason)
if [ -n "$BUSY" ]; then
    log "postponing: $BUSY -- a restart mid-measurement throws away the measurement"
    write_state "blocked" "$BUSY"
    exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
    log "dry run: would deploy ${REMOTE:0:8}"
    git --no-pager log --oneline "$LOCAL..$REMOTE" | while read -r line; do log "  $line"; done
    exit 0
fi

# --- what changed decides what gets rebuilt ---------------------------------
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")

# --force with nothing to pull has an empty diff, so every changed_in() would be
# false and the "forced deploy" would rebuild nothing at all -- which is not what
# --force says it does ("deploys even when the SHAs match, for re-running a
# build"). Treat everything as changed instead.
if [ "$FORCE" -eq 1 ] && [ -z "$CHANGED" ]; then
    log "forced with nothing to pull; rebuilding everything"
    CHANGED="services/ services/api services/fusion services/ui services/sensor-sdr services/sensor-wifi docker/"
fi

changed_in() { printf '%s\n' "$CHANGED" | grep -q "^$1"; }

echo "$LOCAL" > "$STATE_DIR/previous-sha"
log "deploying ${LOCAL:0:8} -> ${REMOTE:0:8}"

# Say so BEFORE the work, not only after it.
#
# Every other write_state call reports something that already happened, which
# left a five-minute docker build looking identical to a unit sitting idle: the
# admin page showed the previous run's verdict, the state file's age crept up,
# and the only way to know a deploy was in flight was to be watching the
# journal. A deploy is the longest-running thing this unit does to itself and
# the one an operator most wants to watch.
write_state "deploying" "rebuilding on this unit; this takes several minutes"

git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1 || die "fast-forward failed; this unit has diverged from $BRANCH"

DEPLOY_OK=1

# Submodules do NOT follow a merge. Without this the pointer in the superproject
# moves and the checkout stays on the old commit, so a "successful" deploy
# silently ships the previous version of anything vendored this way -- which is
# the kind of thing nobody notices until they are debugging a fix that is
# definitely in the repo and definitely not on the box.
#
# `sync` first, so a submodule whose URL changed upstream is repointed rather
# than fetched from the old remote.
if [ -f .gitmodules ]; then
    log "updating submodules"
    if ! git submodule sync --recursive >/dev/null 2>&1 ||
        ! run_logged "$REPO_DIR" 10 -- git submodule update --init --recursive; then
        DEPLOY_OK=0
        fail_step "the submodules could not be updated"
    fi
fi

# The web tier. --build because the images are built on this box; there is no
# registry, and for one Pi there does not need to be.
if changed_in "services/api" || changed_in "services/fusion" || changed_in "services/ui" || changed_in "docker"; then
    log "rebuilding the web tier"
    if ! run_logged "$REPO_DIR/docker" 20 -- docker compose up -d --build; then
        DEPLOY_OK=0
        fail_step "docker compose could not build or start the web tier"
    fi
else
    log "web tier unchanged; not rebuilding"
fi

# The Rust sensor, when the commit touched it. A release build on a Pi is
# minutes, and spending them to install a UI change would take ADS-B down for
# nothing -- so this is the "it changed" case, and rebuild_stale_artefacts
# below covers the "it is older than its sources" case on every run.
if changed_in "services/sensor-sdr"; then
    log "rebuilding the SDR sensor (this takes a few minutes on a Pi)"
    if run_logged "$REPO_DIR/services/sensor-sdr" 5 -- \
        cargo build --release --features rtlsdr; then
        sudo systemctl restart classg-sensor-sdr.service && log "classg-sensor-sdr restarted"
    else
        DEPLOY_OK=0
        fail_step "the SDR sensor did not build; the running binary is untouched"
    fi
fi

# Everything whose ARTEFACT is out of date, whatever the commit touched.
#
# After the rebuilds above rather than instead of them: a commit that changed
# the SDR sensor has already rebuilt it and this finds nothing, while a commit
# that only moved the pi-dash pin is caught here. It is the same call the
# up-to-date path makes, so there is one definition of "stale" rather than one
# per branch of this script.
rebuild_stale_artefacts || true

# The Wi-Fi sensor, into the virtualenv the systemd unit actually runs.
#
# `python3 -m pip install -e .` was wrong twice over, and this is the first
# deploy that ever touched services/sensor-wifi, so it had never once run.
#
# Wrong once because the unit's ExecStart is
# services/sensor-wifi/.venv/bin/python: anything installed into the system
# interpreter is installed where the sensor will never look. Wrong twice
# because Bookworm marks that interpreter externally-managed (PEP 668) and pip
# refuses outright -- which is what failed the deploy and rolled the unit back.
#
# The install is only needed when dependencies or entry points move. The source
# is already what runs, for a stronger reason than the venv's editable install:
# ExecStart is `python -m classg_wifi.cli` with WorkingDirectory set to the
# checkout, and `python -m` puts the working directory first on sys.path -- so
# the checkout wins over any installed copy whatever pip did or did not do.
#
# That is what makes "log the failure and restart anyway" correct rather than a
# gamble. Refusing to restart would leave the sensor running older code than the
# tree this unit now reports it is on, which is the worse of the two outcomes.
if changed_in "services/sensor-wifi"; then
    wifi_dir="$REPO_DIR/services/sensor-wifi"
    wifi_python="$wifi_dir/.venv/bin/python"
    if [ -x "$wifi_python" ]; then
        log "reinstalling the Wi-Fi sensor into its virtualenv"
        if ! run_logged "$wifi_dir" 10 -- "$wifi_python" -m pip install --quiet -e .; then
            # Not fatal. An editable install means the source is already what
            # runs; this only re-resolves dependencies.
            log "pip install failed; restarting on the existing environment anyway"
        fi
    else
        log "no virtualenv at $wifi_python; skipping the install and restarting"
    fi
    sudo systemctl restart classg-sensor-wifi.service && log "classg-sensor-wifi restarted"
fi

# --- did it come back? ------------------------------------------------------
#
# A deploy that leaves the API down is worse than no deploy, and the only way to
# know is to ask it. Generous timeout: the API waits on libSQL and the bus.
log "waiting for the API to answer"
HEALTHY=0
for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "$API/api/v1/health" >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
    sleep 2
done

DEPLOY_AT=$(date -Iseconds -u | sed 's/+00:00/Z/')
DEPLOY_COMMIT="$REMOTE"

if [ "$HEALTHY" -eq 1 ] && [ "$DEPLOY_OK" -eq 1 ]; then
    log "deployed ${REMOTE:0:8} and the API is answering"
    echo "$REMOTE" > "$STATE_DIR/last-good-sha"
    DEPLOY_OK_JSON=true
    write_state "deployed" ""
    exit 0
fi

# Rollback moves the checkout back and rebuilds the web tier from it. It cannot
# un-run a database migration, and it deliberately does not try: schema.sql is
# CREATE TABLE IF NOT EXISTS throughout, so an older binary meets a newer schema
# with extra columns it ignores. Anything that stops being true breaks this
# assumption and needs a real migration story before it ships.
if [ "$HEALTHY" -eq 0 ]; then
    fail_step "the API did not answer after the rebuild"
fi
ROLLBACK_REASON="${FAILED_STEP:-the unit did not come back healthy}"
log "$ROLLBACK_REASON; rolling back to ${LOCAL:0:8}"
git checkout --quiet "$LOCAL" || die "rollback checkout failed -- this unit needs hands"
if changed_in "services/api" || changed_in "services/fusion" || changed_in "services/ui" || changed_in "docker"; then
    run_logged "$REPO_DIR/docker" 5 -- docker compose up -d --build || true
fi
log "rolled back. This unit stays on ${LOCAL:0:8} until someone looks at ${REMOTE:0:8}."
DEPLOY_OK_JSON=false
write_state "failed" "$ROLLBACK_REASON; rolled back to ${LOCAL:0:8}"
exit 1

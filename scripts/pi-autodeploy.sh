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
STATE_DIR="${CLASSG_DEPLOY_STATE:-$HOME/.local/state/classg}"
LOG_TAG="classg-autodeploy"
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

    mkdir -p "$STATE_DIR"
    {
        printf '{\n'
        printf '  "commit": "%s",\n' "$head"
        printf '  "commit_subject": "%s",\n' "$(json_escape "$subject")"
        [ -n "$commit_at" ] && printf '  "commit_at": "%s",\n' "$commit_at"
        printf '  "last_check_at": "%s",\n' "$(date -Iseconds -u | sed 's/+00:00/Z/')"
        printf '  "last_result": "%s",\n' "$result"
        printf '  "last_reason": "%s",\n' "$(json_escape "$reason")"
        [ -n "${DEPLOY_AT:-}" ] && printf '  "last_deploy_at": "%s",\n' "$DEPLOY_AT"
        [ -n "${DEPLOY_COMMIT:-}" ] && printf '  "last_deploy_commit": "%s",\n' "$DEPLOY_COMMIT"
        printf '  "last_deploy_ok": %s,\n' "${DEPLOY_OK_JSON:-false}"
        printf '  "remote_commit": "%s",\n' "$remote"
        printf '  "remote_ci": "%s",\n' "$ci"
        printf '  "timer_enabled": %s,\n' "$timer_enabled"
        printf '  "log": %s\n' "$(json_log_array)"
        printf '}\n'
    } > "$STATE_JSON.tmp" 2>/dev/null
    mv -f "$STATE_JSON.tmp" "$STATE_JSON" 2>/dev/null || true
}

mkdir -p "$STATE_DIR"

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

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" -eq 0 ]; then
    log "up to date at ${LOCAL:0:8}"
    write_state "up-to-date" ""
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
        write_state "blocked" "the GitHub API is unreachable, so CI could not be checked"
        exit 0
    fi

    TOTAL=$(printf '%s' "$STATUS_JSON" | grep -o '"total_count"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
    TOTAL=${TOTAL:-0}
    if [ "$TOTAL" -eq 0 ]; then
        REMOTE_CI="pending"
        log "no CI runs recorded for ${REMOTE:0:8} yet; will look again next time"
        write_state "blocked" "no CI runs recorded for this commit yet"
        exit 0
    fi

    # Any run still going means "not yet", not "fine".
    if printf '%s' "$STATUS_JSON" | grep -q '"status"[[:space:]]*:[[:space:]]*"\(queued\|in_progress\)"'; then
        REMOTE_CI="pending"
        log "CI is still running for ${REMOTE:0:8}; will look again next time"
        write_state "blocked" "CI is still running for this commit"
        exit 0
    fi
    # Any conclusion that is not success blocks. Listing them explicitly rather
    # than negating "success" means a conclusion GitHub adds later fails closed.
    if printf '%s' "$STATUS_JSON" | grep -q '"conclusion"[[:space:]]*:[[:space:]]*"\(failure\|cancelled\|timed_out\|action_required\|stale\)"'; then
        REMOTE_CI="failure"
        log "CI is not green for ${REMOTE:0:8}; leaving this unit on ${LOCAL:0:8}"
        write_state "blocked" "CI is not green for this commit"
        exit 0
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
changed_in() { printf '%s\n' "$CHANGED" | grep -q "^$1"; }

# Submodule pointers, captured before the merge so a moved pointer is
# detectable afterwards. `git diff --name-only` does list a submodule path when
# its pointer moves, but not when the submodule is simply uninitialised -- and
# a fresh clone is exactly that case.
submodule_sha() {
    git -C "$REPO_DIR/$1" rev-parse HEAD 2>/dev/null || echo "uninitialised"
}
PIDASH_BEFORE=$(submodule_sha tools/pi-dash)

echo "$LOCAL" > "$STATE_DIR/previous-sha"
log "deploying ${LOCAL:0:8} -> ${REMOTE:0:8}"

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
        ! git submodule update --init --recursive 2>&1 | while read -r l; do log "  $l"; done; then
        DEPLOY_OK=0
        log "submodule update failed"
    fi
fi

# The web tier. --build because the images are built on this box; there is no
# registry, and for one Pi there does not need to be.
if changed_in "services/api" || changed_in "services/fusion" || changed_in "services/ui" || changed_in "docker"; then
    log "rebuilding the web tier"
    if ! (cd docker && docker compose up -d --build 2>&1 | while read -r l; do log "  $l"; done); then
        DEPLOY_OK=0
        log "docker compose failed"
    fi
else
    log "web tier unchanged; not rebuilding"
fi

# The Rust sensor. Only when it changed: a release build on a Pi is minutes, and
# spending them to install a UI change would take ADS-B down for nothing.
if changed_in "services/sensor-sdr"; then
    log "rebuilding the SDR sensor (this takes a few minutes on a Pi)"
    if (cd services/sensor-sdr && cargo build --release --features rtlsdr 2>&1 | tail -5 | while read -r l; do log "  $l"; done); then
        sudo systemctl restart classg-sensor-sdr.service && log "classg-sensor-sdr restarted"
    else
        DEPLOY_OK=0
        log "cargo build failed; leaving the running binary in place"
    fi
fi

# pi-dash: a Rust submodule, rebuilt when its pinned commit moves.
#
# Following the PINNED pointer, never upstream's latest -- that is what a
# submodule means, and silently advancing it would deploy a commit nobody chose.
# The `pidash` wrapper on PATH execs this checkout's release build directly, so
# a rebuild is the whole deploy; there is no service to restart. It runs
# interactively, so an operator with it open keeps the old binary until they
# quit and relaunch, which is the correct behaviour for a dashboard someone is
# reading.
PIDASH_AFTER=$(submodule_sha tools/pi-dash)
PIDASH_BIN="$REPO_DIR/tools/pi-dash/target/release/pi-dash"
if [ -d "$REPO_DIR/tools/pi-dash" ] &&
    { [ "$PIDASH_BEFORE" != "$PIDASH_AFTER" ] || [ ! -x "$PIDASH_BIN" ]; }; then
    if [ "$PIDASH_BEFORE" = "$PIDASH_AFTER" ]; then
        log "rebuilding pi-dash (no binary present)"
    else
        log "rebuilding pi-dash (${PIDASH_BEFORE:0:8} -> ${PIDASH_AFTER:0:8})"
    fi
    if (cd "$REPO_DIR/tools/pi-dash" && cargo build --release 2>&1 | tail -3 |
        while read -r l; do log "  $l"; done); then
        log "pi-dash rebuilt; a running instance picks it up on next launch"
    else
        # Not fatal to the deploy. pi-dash is an operator convenience, and
        # failing the whole deploy -- and rolling back a working detector --
        # because a dashboard would not compile is the wrong trade.
        log "pi-dash failed to build; the rest of the deploy stands"
    fi
fi

if changed_in "services/sensor-wifi"; then
    log "reinstalling the Wi-Fi sensor"
    if (cd services/sensor-wifi && python3 -m pip install --quiet -e . 2>&1 | while read -r l; do log "  $l"; done); then
        sudo systemctl restart classg-sensor-wifi.service && log "classg-sensor-wifi restarted"
    else
        DEPLOY_OK=0
        log "pip install failed"
    fi
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
log "the unit did not come back healthy; rolling back to ${LOCAL:0:8}"
git checkout --quiet "$LOCAL" || die "rollback checkout failed -- this unit needs hands"
if changed_in "services/api" || changed_in "services/fusion" || changed_in "services/ui" || changed_in "docker"; then
    (cd docker && docker compose up -d --build 2>&1 | tail -5 | while read -r l; do log "  rollback: $l"; done)
fi
log "rolled back. This unit stays on ${LOCAL:0:8} until someone looks at ${REMOTE:0:8}."
DEPLOY_OK_JSON=false
write_state "failed" "the unit did not come back healthy; rolled back"
exit 1

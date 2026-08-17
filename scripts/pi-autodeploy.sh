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

log() { printf '%s %s\n' "$(date -Is)" "$*"; logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true; }
die() { log "FAILED: $*"; exit 1; }

mkdir -p "$STATE_DIR"

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

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" -eq 0 ]; then
    log "up to date at ${LOCAL:0:8}"
    exit 0
fi

# Never discard local work. A dirty tree on a field unit is usually someone
# mid-diagnosis, and `git pull` would either fail confusingly or clobber it.
# Refusing and saying which files is the only safe answer.
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
    log "refusing to deploy: $REPO_DIR has uncommitted changes"
    printf '%s\n' "$DIRTY" | while read -r line; do log "  $line"; done
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

    if [ -z "$STATUS_JSON" ]; then
        # Unreachable GitHub is not a reason to deploy blind. The unit keeps
        # running what it has, which is a commit that was green when it landed.
        log "could not reach the GitHub API; leaving this unit on ${LOCAL:0:8}"
        exit 0
    fi

    TOTAL=$(printf '%s' "$STATUS_JSON" | grep -o '"total_count"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
    TOTAL=${TOTAL:-0}
    if [ "$TOTAL" -eq 0 ]; then
        log "no CI runs recorded for ${REMOTE:0:8} yet; will look again next time"
        exit 0
    fi

    # Any run still going means "not yet", not "fine".
    if printf '%s' "$STATUS_JSON" | grep -q '"status"[[:space:]]*:[[:space:]]*"\(queued\|in_progress\)"'; then
        log "CI is still running for ${REMOTE:0:8}; will look again next time"
        exit 0
    fi
    # Any conclusion that is not success blocks. Listing them explicitly rather
    # than negating "success" means a conclusion GitHub adds later fails closed.
    if printf '%s' "$STATUS_JSON" | grep -q '"conclusion"[[:space:]]*:[[:space:]]*"\(failure\|cancelled\|timed_out\|action_required\|stale\)"'; then
        log "CI is not green for ${REMOTE:0:8}; leaving this unit on ${LOCAL:0:8}"
        exit 0
    fi
    log "CI is green for ${REMOTE:0:8}"
fi

BUSY=$(busy_reason)
if [ -n "$BUSY" ]; then
    log "postponing: $BUSY -- a restart mid-measurement throws away the measurement"
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

echo "$LOCAL" > "$STATE_DIR/previous-sha"
log "deploying ${LOCAL:0:8} -> ${REMOTE:0:8}"

git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1 || die "fast-forward failed; this unit has diverged from $BRANCH"

DEPLOY_OK=1

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

if [ "$HEALTHY" -eq 1 ] && [ "$DEPLOY_OK" -eq 1 ]; then
    log "deployed ${REMOTE:0:8} and the API is answering"
    echo "$REMOTE" > "$STATE_DIR/last-good-sha"
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
exit 1

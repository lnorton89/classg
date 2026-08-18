#!/usr/bin/env bash
# Make the agent-state directory usable from BOTH sides of the fence.
#
# The API runs in a container as its own unprivileged user; the deploy agent,
# the watchdog and the sweep agent run on the host as the operator. They talk
# by exchanging files in one directory, which means one directory has to be
# writable by two users that share nothing.
#
# Getting this half-right is worse than getting it wrong, and it is what
# happened: the directory was mode 0755 owned by the host user, so the
# container could READ it. Everything that only reads worked -- the Spectrum
# page listed the bands, reported the sweep agent available, and offered the
# button. The first actual sweep failed with
#
#   writing the sweep request: /var/lib/classg/agent-state/spectrum-request.json:
#   permission denied
#
# and the deploy button had been equally broken the whole time, unnoticed
# because nobody had pressed it.
#
# The fix is a shared GROUP rather than a shared uid:
#
#   - the directory is 2775, group-writable, with setgid so anything created
#     inside carries the directory's group whichever side made it;
#   - the api container joins that group with `group_add` in compose, keeping
#     its own uid and gaining nothing else.
#
# World-writable would also "work" and is not on the table. A deploy-request
# marker in this directory starts a deploy, so write access to it is a
# privilege boundary, not a convenience.
#
# Idempotent. Run it as often as you like.

set -euo pipefail

REPO_DIR="${CLASSG_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${CLASSG_DEPLOY_STATE:-$REPO_DIR/.agent-state}"
COMPOSE_ENV="$REPO_DIR/docker/.env"
CONTAINER="${CLASSG_API_CONTAINER:-classg-api}"
# Where the mount lands inside the container. Matches docker-compose.yml.
CONTAINER_STATE_DIR=/var/lib/classg/agent-state

log() { printf '  %s\n' "$*"; }

echo "Agent state directory: $STATE_DIR"

if [ ! -d "$STATE_DIR" ]; then
    mkdir -p "$STATE_DIR"
    log "created"
fi

# Docker creates a missing bind-mount source as root, so a directory that
# exists may not be ours at all. Say which it is rather than failing on a
# chmod three lines later.
if [ ! -w "$STATE_DIR" ]; then
    echo "$STATE_DIR is not writable by $(id -un)." >&2
    echo "Docker creates a missing bind mount as root. Fix with:" >&2
    echo "    sudo chown -R $(id -un):$(id -gn) $STATE_DIR" >&2
    exit 1
fi

STATE_GID="$(stat -c %g "$STATE_DIR")"
chmod 2775 "$STATE_DIR"
log "mode $(stat -c %a "$STATE_DIR"), group $(stat -c %G "$STATE_DIR") ($STATE_GID)"

# Existing files predate the setgid bit and may carry the wrong group. Only
# files -- the agents and the API both rewrite by rename, so a file with the
# wrong group is a file neither side can replace.
find "$STATE_DIR" -maxdepth 2 ! -group "$STATE_GID" -exec chgrp "$STATE_GID" {} + 2>/dev/null || true
find "$STATE_DIR" -maxdepth 2 -type f ! -perm -g=w -exec chmod g+w {} + 2>/dev/null || true

# compose reads docker/.env, NOT the repo-root one. Recorded there rather than
# hardcoded in the compose file because the operator account is 1000 on a
# stock Pi OS image and something else on a box where it is not.
touch "$COMPOSE_ENV"
if grep -q '^CLASSG_AGENT_STATE_GID=' "$COMPOSE_ENV"; then
    CURRENT=$(grep '^CLASSG_AGENT_STATE_GID=' "$COMPOSE_ENV" | head -1 | cut -d= -f2)
else
    CURRENT=""
fi
if [ "$CURRENT" != "$STATE_GID" ]; then
    # sed -i on a match, append otherwise. Never rewrite the whole file: it
    # holds the operator's own settings and possibly credentials.
    if [ -n "$CURRENT" ]; then
        sed -i "s/^CLASSG_AGENT_STATE_GID=.*/CLASSG_AGENT_STATE_GID=$STATE_GID/" "$COMPOSE_ENV"
    else
        printf 'CLASSG_AGENT_STATE_GID=%s\n' "$STATE_GID" >> "$COMPOSE_ENV"
    fi
    log "recorded CLASSG_AGENT_STATE_GID=$STATE_GID in docker/.env"
fi

# --- and now prove it, because reading is not writing --------------------
#
# The check that missed this the first time confirmed the container could SEE
# the band file. Availability needs a read; a sweep needs a write. Nothing
# short of writing from inside the container tests the thing that broke.
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    log "no $CONTAINER container yet; the write check runs on the next install"
    exit 0
fi

probe() {
    docker exec "$CONTAINER" sh -c \
        "touch $CONTAINER_STATE_DIR/.write-probe && rm -f $CONTAINER_STATE_DIR/.write-probe" \
        >/dev/null 2>&1
}

if probe; then
    log "the API container can write to it"
    exit 0
fi

log "the API container cannot write to it yet; recreating it to pick up the group"
log "(the API is unavailable for a second or two -- the sensors keep running)"
(cd "$REPO_DIR/docker" && docker compose up -d api >/dev/null 2>&1) || true

for _ in 1 2 3 4 5 6 7 8 9 10; do
    if probe; then
        log "the API container can write to it"
        exit 0
    fi
    sleep 1
done

echo "The API container still cannot write to $STATE_DIR." >&2
echo "Check that docker/docker-compose.yml has group_add on the api service," >&2
echo "then:  cd $REPO_DIR/docker && docker compose up -d --force-recreate api" >&2
exit 1

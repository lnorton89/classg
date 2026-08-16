#!/usr/bin/env bash
# Native development loop. No containers, no image rebuilds, no UI rebuild.
#
#   ./scripts/dev.sh              fusion + api + vite
#   ./scripts/dev.sh --no-fusion  api + vite (fusion not needed for UI work)
#   ./scripts/dev.sh --ui-only    vite alone, MSW mocks, no Go at all
#
# Why native rather than Compose:
#   Containers are the DEPLOYMENT story. For editing, they cost an image rebuild
#   or a bind-mount whose inotify events do not always reach the container, so
#   watchers silently miss changes. Running the three processes directly gives
#   sub-second reload and works identically on a dev box and a
#   Pi. Use `make compose-up` when you specifically want to test the container
#   path.
#
# Hot reload:
#   Go   - `air` if installed, else plain `go run` (restart by hand)
#          install: go install github.com/air-verse/air@latest
#   UI   - Vite HMR, always
#
# The API serves NO static UI here (CLASSG_UI_DIR=off); Vite serves the app and
# proxies /api to the API. That is what removes `make build-ui` from the loop.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

RUN_FUSION=1
RUN_API=1
RUN_UI=1

for arg in "$@"; do
    case "$arg" in
        --no-fusion) RUN_FUSION=0 ;;
        --no-ui)     RUN_UI=0 ;;
        --ui-only)   RUN_FUSION=0; RUN_API=0 ;;
        -h|--help)   sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# --- reclaim ports from a previous run --------------------------------------
# A killed terminal leaves `go run`'s child binary and Vite holding their ports,
# and the next `make dev` fails with a bind error that names a port rather than
# a cause. Reclaiming up front is what makes the loop restartable.

port_pids() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null
    elif command -v ss >/dev/null 2>&1; then
        ss -lptnH "sport = :${port}" 2>/dev/null |
            grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
    elif command -v fuser >/dev/null 2>&1; then
        fuser -n tcp "${port}" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$'
    fi
}

reclaim_port() {
    local port="$1" label="$2" pids
    pids="$(port_pids "$port" || true)"
    [ -z "$pids" ] && return 0
    for pid in $pids; do
        # Say what is being killed rather than doing it silently -- if it is not
        # actually a leftover, the user needs to know before it dies.
        local name
        name="$(ps -p "$pid" -o comm= 2>/dev/null || echo '?')"
        echo "  reclaiming port $port ($label) from pid $pid [$name]"
        kill "$pid" 2>/dev/null || true
    done
    # Give them a moment to release, then insist.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pids="$(port_pids "$port" || true)"
        [ -z "$pids" ] && return 0
        sleep 0.2
    done
    for pid in $(port_pids "$port" || true); do
        echo "  port $port still held by pid $pid, sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
    done
}

PIDS=()
cleanup() {
    echo
    echo "shutting down..."
    for pid in "${PIDS[@]}"; do
        # Kill the whole process group: `go run` spawns a child binary that
        # otherwise survives and keeps the port bound.
        kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null
}
trap cleanup INT TERM EXIT

start() {
    local name="$1"; shift
    echo "  starting $name"
    ( set -m; "$@" 2>&1 | sed "s/^/[$name] /" ) &
    PIDS+=($!)
}

[ -f .env ] || { echo "creating .env from .env.example"; cp .env.example .env; }

echo "ClassG dev loop"
echo

# Only reclaim ports this run is about to bind. 5556 is deliberately excluded:
# the Wi-Fi sensor binds it, and that is a legitimately running process, not a
# leftover of ours.
[ "$RUN_UI" -eq 1 ]     && reclaim_port 5173 "vite"
[ "$RUN_API" -eq 1 ]    && reclaim_port 8081 "api"
[ "$RUN_FUSION" -eq 1 ] && reclaim_port 5557 "fusion tracks"

# Stale `go run` children survive their parent and keep rebuilding stale code.
for stale in classg-api classg-fusion; do
    pids="$(pgrep -x "$stale" 2>/dev/null || true)"
    for pid in $pids; do
        echo "  killing leftover $stale (pid $pid)"
        kill "$pid" 2>/dev/null || true
    done
done

if [ "$RUN_FUSION" -eq 1 ]; then
    start fusion sh -c 'cd services/fusion && go run ./cmd/classg-fusion'
    sleep 1
fi

if [ "$RUN_API" -eq 1 ]; then
    # CLASSG_UI_DIR=off: Vite owns the UI in dev. Serving a stale dist/ from the
    # Go binary is the single most confusing thing that can happen here -- you
    # edit a component, reload, and see yesterday's build.
    if command -v air >/dev/null 2>&1; then
        start api env CLASSG_UI_DIR=off sh -c 'cd services/api && air'
    else
        start api env CLASSG_UI_DIR=off sh -c 'cd services/api && go run ./cmd/classg-api'
    fi
    sleep 1
fi

if [ "$RUN_UI" -eq 1 ]; then
    start ui sh -c 'cd services/ui && npm run dev'
fi

echo
echo "  UI   http://localhost:5173"
[ "$RUN_API" -eq 1 ] && echo "  API  http://localhost:8081/api/v1"
echo
if ! command -v air >/dev/null 2>&1 && [ "$RUN_API" -eq 1 ]; then
    echo "  (Go changes need a manual restart. For auto-reload:"
    echo "   go install github.com/air-verse/air@latest)"
    echo
fi
echo "  Ctrl-C to stop everything."
wait

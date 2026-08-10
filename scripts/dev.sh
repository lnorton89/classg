#!/usr/bin/env bash
# Native development loop. No containers, no image rebuilds, no UI rebuild.
#
#   ./scripts/dev.sh              fusion + api + vite
#   ./scripts/dev.sh --no-fusion  api + vite (fusion not needed for UI work)
#   ./scripts/dev.sh --ui-only    vite alone, MSW mocks, no Go at all
#
# Why native rather than Compose:
#   Containers are the DEPLOYMENT story. For editing, they cost an image rebuild
#   or a bind-mount whose inotify events do not reliably cross the Windows/WSL
#   boundary, so watchers silently miss changes. Running the three processes
#   directly gives sub-second reload and works identically on WSL, Linux and a
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
cd "$REPO_ROOT"

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

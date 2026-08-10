#!/usr/bin/env bash
# Use the Windows Docker CLI from WSL. This keeps Docker Desktop out of the
# custom ClassG WSL kernel while preserving normal `docker compose` commands.
set -euo pipefail

if grep -qi microsoft /proc/version 2>/dev/null; then
    if command -v docker.exe >/dev/null 2>&1; then
        exec docker.exe "$@"
    fi
    windows_docker="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
    if [ -x "$windows_docker" ]; then
        exec "$windows_docker" "$@"
    fi
    echo "Windows Docker CLI not found. Install Docker Desktop for Windows." >&2
    exit 127
fi

exec docker "$@"

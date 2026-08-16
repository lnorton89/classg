#!/usr/bin/env bash
# Refuse to start the Docker dev stack while a native one is running.
#
# Why this exists: both loops claim the same ports, so bringing up the second
# one fails at bind time. Docker reports that as "port is already allocated",
# which names a port and nothing else -- not which process holds it, and not
# that you started it yourself half an hour ago. This names the processes and
# how to stop them, which is the part you actually need.

set -uo pipefail

FOUND=0
report() { echo "  $1"; FOUND=1; }

# Processes started by scripts/dev.sh (make dev-native).
while read -r pid args; do
    [ -z "${pid:-}" ] && continue
    report "pid $pid  $args"
done < <(pgrep -af 'classg-api|classg-fusion|go run \./cmd/classg-|services/ui.*vite' 2>/dev/null |
         grep -v 'docker' || true)

if [ "$FOUND" -eq 1 ]; then
    cat <<'EOS'

A native dev loop is already running and holds the ports the containers
publish, so the stack will fail to bind.

Stop it first:

  pkill -f 'scripts/dev.sh'; pkill -f 'go run ./cmd/classg-'; pkill -f 'classg-api'

Then re-run: make dev
EOS
    exit 1
fi

exit 0

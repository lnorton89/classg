#!/usr/bin/env bash
# Refuse to start the Docker dev stack while a native one is running.
#
# Why this exists: WSL's localhost forwarding means a native process bound to
# 8081 WINS over a container publishing 8081. Both appear healthy, `docker ps`
# looks right, and every request goes to the native process. The symptom is a
# working API serving stale code with configuration you did not set -- which is
# indistinguishable from a broken container until you compare uptime.
#
# Cost of that failure once: about an hour.

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

A native dev loop is already running. It will shadow the containers: WSL
forwards localhost to the native process, so the API you reach would be that
one, not the container.

Stop it first:

  pkill -f 'scripts/dev.sh'; pkill -f 'go run ./cmd/classg-'; pkill -f 'classg-api'

Then re-run: make dev
EOS
    exit 1
fi

exit 0

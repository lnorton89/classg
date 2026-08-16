#!/usr/bin/env bash
# Render and install the ClassG systemd units for THIS checkout.
#
#   sudo ./deploy/systemd/install.sh [interface]
#
# The units are templates rather than plain .service files because systemd will
# not expand a variable into the ExecStart binary path -- it has to be literal
# and absolute. Rendering from the checkout's real location is the alternative
# to hard-coding /opt/classg and hoping everyone deployed there.
set -euo pipefail

IFACE="${1:-wlan1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSG_HOME="$(cd "$HERE/../.." && pwd)"

if [[ $EUID -ne 0 ]]; then
    echo "must run as root" >&2
    exit 1
fi

if [[ ! -f "$CLASSG_HOME/.env" ]]; then
    echo "no $CLASSG_HOME/.env -- run 'make env' first" >&2
    exit 1
fi

# EnvironmentFile= is stricter than a shell: it takes KEY=VALUE and comments and
# nothing else. A line continuation or a $(...) in .env would make the unit fail
# to start with a message that does not mention .env at all.
if grep -qE '^\s*[A-Za-z_][A-Za-z0-9_]*=.*(\$\(|`|\\$)' "$CLASSG_HOME/.env"; then
    echo "warning: .env contains shell expansion; systemd EnvironmentFile will" >&2
    echo "         pass it through literally, not evaluate it." >&2
fi

shopt -s nullglob
installed=0
for tpl in "$HERE"/*.service.in; do
    unit="$(basename "$tpl" .in)"
    sed -e "s|@CLASSG_HOME@|$CLASSG_HOME|g" \
        -e "s|@IFACE@|$IFACE|g" \
        "$tpl" > "/etc/systemd/system/$unit"
    echo "installed /etc/systemd/system/$unit"
    installed=$((installed + 1))
done

if [[ $installed -eq 0 ]]; then
    echo "no unit templates found in $HERE" >&2
    exit 1
fi

systemctl daemon-reload

cat <<EOS

Rendered for $CLASSG_HOME on $IFACE. Enable what you want running:

  systemctl enable --now classg-sensor-wifi

The web tier is Compose, not systemd -- it already restarts itself
(restart: unless-stopped). Use 'make compose-up' for that.
EOS

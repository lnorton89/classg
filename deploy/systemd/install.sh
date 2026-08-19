#!/usr/bin/env bash
# Render and install the ClassG systemd units for THIS checkout.
#
#   sudo ./deploy/systemd/install.sh [primary-interface]
#
# The units are templates rather than plain .service files because systemd will
# not expand a variable into the ExecStart binary path -- it has to be literal
# and absolute. Rendering from the checkout's real location is the alternative
# to hard-coding /opt/classg and hoping everyone deployed there.
set -euo pipefail

IFACE="${1:-wlan-alfa}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSG_HOME="$(cd "$HERE/../.." && pwd)"
UDEV_RULE="$CLASSG_HOME/deploy/udev/70-classg-wifi.rules"

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

if ! grep -qE '^CLASSG_WIFI_SOCKET_MODE=connect\s*$' "$CLASSG_HOME/.env"; then
    echo "warning: two Wi-Fi publishers require CLASSG_WIFI_SOCKET_MODE=connect" >&2
    echo "         with fusion listening on the detection endpoint." >&2
fi

configured_capture_iface="$(sed -n 's/^CLASSG_WIFI_INTERFACE=//p' "$CLASSG_HOME/.env" | tail -1)"
if [[ -n "$configured_capture_iface" && "$configured_capture_iface" != "$IFACE" ]]; then
    echo "warning: .env sets CLASSG_WIFI_INTERFACE=$configured_capture_iface" >&2
    echo "         change it to $IFACE so operator captures use the primary adapter." >&2
fi

# Give the radios names based on USB identity, not probe order. Installing the
# rule does not rename a live interface under a running capture; it takes effect
# on the next replug or reboot.
if [[ -f "$UDEV_RULE" ]]; then
    install -m 0644 "$UDEV_RULE" /etc/udev/rules.d/70-classg-wifi.rules
    udevadm control --reload-rules
    echo "installed /etc/udev/rules.d/70-classg-wifi.rules"
fi

shopt -s nullglob
installed=0
# Who the units run as. Neither sensor runs as root any more: the Wi-Fi one
# gets AF_PACKET through AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN (its
# ExecStartPre=+ still runs setup-monitor.sh privileged), and the SDR one only
# reads a TCP socket from dump1090. The checkout's owner is the closest thing
# to "whoever deployed this" that survives being run under sudo, where $USER is
# root and SUDO_USER is unset for a root login.
RUNAS="$(stat -c %U "$CLASSG_HOME")"
if [[ -z "$RUNAS" || "$RUNAS" == "UNKNOWN" ]]; then
    RUNAS="${SUDO_USER:-root}"
fi
echo "unprivileged units will run as: $RUNAS"

for tpl in "$HERE"/*.service.in; do
    unit="$(basename "$tpl" .in)"
    sed -e "s|@CLASSG_HOME@|$CLASSG_HOME|g" \
        -e "s|@IFACE@|$IFACE|g" \
        -e "s|@RUNAS@|$RUNAS|g" \
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

Rendered for $CLASSG_HOME with primary interface $IFACE.

After replugging the adapters (or rebooting), enable the primary receiver:

  systemctl enable --now classg-sensor-wifi

If the TP-Link is fitted as wlan-tplink, enable the companion sweep receiver:

  systemctl enable --now classg-sensor-wifi-tplink

The watchdog, sweep and deploy agents were rendered too, but not enabled:
each needs a sudoers grant and (for two of them) a timer, which their own
installers add -- scripts/install-watchdog.sh, install-sweep-agent.sh,
install-autodeploy.sh.

The web tier is Compose, not systemd -- it already restarts itself
(restart: unless-stopped). Use 'make compose-up' for that.
EOS

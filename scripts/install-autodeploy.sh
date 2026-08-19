#!/usr/bin/env bash
# Install the host-side agents on this unit: the watchdog, and optionally
# auto-deploy.
#
# Deliberately a separate, explicit step rather than something `make deploy`
# turns on. Automatic deployment to a live detection unit means the unit stops
# detecting, without warning, at a moment nobody chose -- that is a decision an
# operator makes on purpose, not a default they inherit.

set -euo pipefail

# Derived from this script's own location, not $HOME. These scripts sudo
# internally, so they are meant to be run as the operator -- but running them
# WITH sudo is the obvious thing to try, and then $HOME is /root, REPO_DIR is
# /root/classg, and the script exits "no checkout" before it writes anything.
# That failure is silent in a chain: the units install, the sudoers grants
# quietly do not, and the agents lose the ability to restart a sensor.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CLASSG_REPO_DIR:-$(cd "$HERE/.." && pwd)}"
UNIT_DIR=/etc/systemd/system
SUDOERS=/etc/sudoers.d/classg-autodeploy

[ -d "$REPO_DIR/.git" ] || { echo "no checkout at $REPO_DIR" >&2; exit 1; }

echo "Installing the auto-deploy timer from $REPO_DIR"

# The unit is a template rendered against this checkout, same mechanism as
# deploy/systemd/install.sh: systemd will not expand a variable into the
# ExecStart binary path, so it has to be literal and absolute. The checkout's
# owner is who the unit runs as -- the closest thing to "whoever deployed this"
# that survives being run under sudo, where $USER is root and SUDO_USER can be
# unset for a root login.
RUNAS="$(stat -c %U "$REPO_DIR")"
if [ -z "$RUNAS" ] || [ "$RUNAS" = "UNKNOWN" ]; then
    RUNAS="${SUDO_USER:-$USER}"
fi

render_unit() {
    # Render to a temp file so `sudo install` still sets mode and ownership.
    tmp="$(mktemp)"
    sed -e "s|@CLASSG_HOME@|$REPO_DIR|g" \
        -e "s|@RUNAS@|$RUNAS|g" \
        "$REPO_DIR/deploy/systemd/$1.in" > "$tmp"
    sudo install -m 0644 "$tmp" "$UNIT_DIR/$1"
    rm -f "$tmp"
}

# Create the shared state directory NOW, owned by this user.
#
# Order matters. Docker creates a missing bind-mount source itself, as root, and
# the agents then cannot write to the directory the container made for them --
# which is exactly what happened on first install here. Creating it first means
# Compose finds it and leaves the ownership alone.
#
# One directory, two users that share nothing, so ownership, permissions, the
# gid compose needs and a real write test from inside the container all live in
# one script: getting it half-right leaves every read path working and every
# write failing, which is how a broken deploy button went unnoticed.
"$REPO_DIR/scripts/agent-state-setup.sh"

render_unit classg-autodeploy.service
sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-autodeploy.timer" "$UNIT_DIR/"

# The narrowest sudo that works: exactly the two restarts the deploy needs, and
# nothing else. NOPASSWD on a broad systemctl would make this timer a general
# privilege escalation for anyone who can write to the repo.
echo "Granting passwordless restart for the two sensor units only"
# The grant goes to the unit's User= (the checkout owner), which is not
# necessarily whoever ran this installer.
sudo tee "$SUDOERS" >/dev/null <<EOF
$RUNAS ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-sdr.service
$RUNAS ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-wifi.service
$RUNAS ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-wifi-tplink.service
EOF
sudo chmod 0440 "$SUDOERS"
sudo visudo -cf "$SUDOERS" >/dev/null || { echo "sudoers file is invalid; removing" >&2; sudo rm -f "$SUDOERS"; exit 1; }

sudo systemctl daemon-reload
sudo systemctl enable --now classg-autodeploy.timer

echo
echo "Enabled. Next run:"
systemctl list-timers classg-autodeploy.timer --no-pager || true
echo
echo "Watch it:      journalctl -t classg-autodeploy -f"
echo "Run it now:    ./scripts/pi-autodeploy.sh"
echo "See the plan:  ./scripts/pi-autodeploy.sh --dry-run"
echo "Turn it off:   sudo systemctl disable --now classg-autodeploy.timer"

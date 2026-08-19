#!/usr/bin/env bash
# Install the self-repair watchdog on this unit.
#
# Separate from install-autodeploy.sh because they are different decisions.
# Auto-deploy changes what the unit runs; the watchdog only tries to keep
# running what is already there. Almost everyone wants the second and not
# necessarily the first.

set -euo pipefail

REPO_DIR="${CLASSG_REPO_DIR:-$HOME/classg}"
UNIT_DIR=/etc/systemd/system
SUDOERS=/etc/sudoers.d/classg-watchdog

[ -d "$REPO_DIR/.git" ] || { echo "no checkout at $REPO_DIR" >&2; exit 1; }

echo "Installing the watchdog from $REPO_DIR"

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

render_unit classg-watchdog.service
sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-watchdog.timer" "$UNIT_DIR/"

# Exactly the two restarts a repair needs, and nothing else. NOPASSWD on a
# broader systemctl would make this timer a general privilege escalation for
# anyone who can write to the repo.
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
sudo systemctl enable --now classg-watchdog.timer

echo
systemctl list-timers classg-watchdog.timer --no-pager || true
echo
echo "Watch it:        journalctl -t classg-watchdog -f"
echo "See the plan:    ./scripts/classg-watchdog.sh --dry-run"
echo "Run it now:      ./scripts/classg-watchdog.sh"
echo "Forget history:  ./scripts/classg-watchdog.sh --reset"
echo "Turn it off:     sudo systemctl disable --now classg-watchdog.timer"

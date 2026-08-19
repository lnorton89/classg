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

sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-watchdog.service" "$UNIT_DIR/"
sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-watchdog.timer" "$UNIT_DIR/"

# Exactly the two restarts a repair needs, and nothing else. NOPASSWD on a
# broader systemctl would make this timer a general privilege escalation for
# anyone who can write to the repo.
echo "Granting passwordless restart for the two sensor units only"
sudo tee "$SUDOERS" >/dev/null <<EOF
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-sdr.service
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-wifi.service
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-wifi-tplink.service
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

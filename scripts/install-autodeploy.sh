#!/usr/bin/env bash
# Install the auto-deploy timer on this unit.
#
# Deliberately a separate, explicit step rather than something `make deploy`
# turns on. Automatic deployment to a live detection unit means the unit stops
# detecting, without warning, at a moment nobody chose -- that is a decision an
# operator makes on purpose, not a default they inherit.

set -euo pipefail

REPO_DIR="${CLASSG_REPO_DIR:-$HOME/classg}"
UNIT_DIR=/etc/systemd/system
SUDOERS=/etc/sudoers.d/classg-autodeploy

[ -d "$REPO_DIR/.git" ] || { echo "no checkout at $REPO_DIR" >&2; exit 1; }

echo "Installing the auto-deploy timer from $REPO_DIR"

sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-autodeploy.service" "$UNIT_DIR/"
sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-autodeploy.timer" "$UNIT_DIR/"

# The narrowest sudo that works: exactly the two restarts the deploy needs, and
# nothing else. NOPASSWD on a broad systemctl would make this timer a general
# privilege escalation for anyone who can write to the repo.
echo "Granting passwordless restart for the two sensor units only"
sudo tee "$SUDOERS" >/dev/null <<EOF
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-sdr.service
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-wifi.service
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

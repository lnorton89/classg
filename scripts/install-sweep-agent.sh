#!/usr/bin/env bash
# Install the sweep agent, so the Spectrum page works.
#
# The API cannot sweep from inside its container -- no sensor binary, no
# /dev/bus/usb, no librtlsdr. This puts the work on the host, where the radio
# and the privileges already are.

set -euo pipefail

REPO_DIR="${CLASSG_REPO_DIR:-$HOME/classg}"
UNIT_DIR=/etc/systemd/system
SUDOERS=/etc/sudoers.d/classg-sweep-agent
SDR_BIN="$REPO_DIR/services/sensor-sdr/target/release/classg-sensor-sdr"

[ -d "$REPO_DIR/.git" ] || { echo "no checkout at $REPO_DIR" >&2; exit 1; }

echo "Installing the sweep agent from $REPO_DIR"

# One directory, two users that share nothing: the host agents run as the
# operator and the API runs in a container as its own user. Ownership,
# permissions, the gid compose needs, and a real write test from inside the
# container all live in one place, because getting it half-right leaves every
# read path working and every write failing.
"$REPO_DIR/scripts/agent-state-setup.sh"

# The sweep engine only exists in a build with the rtlsdr feature. Without it
# the binary refuses every sweep with a clear message, which is a worse thing to
# discover from the web app than from here.
if [ ! -x "$SDR_BIN" ]; then
    echo "no sensor binary at $SDR_BIN" >&2
    echo "build it:  cd $REPO_DIR/services/sensor-sdr && cargo build --release --features rtlsdr" >&2
    exit 1
fi
if ! "$SDR_BIN" bands --json >/dev/null 2>&1; then
    echo "$SDR_BIN cannot list bands; is it built with --features rtlsdr?" >&2
    exit 1
fi

sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-sweep-agent.service" "$UNIT_DIR/"

# Exactly the two commands a sweep needs to borrow the radio, and nothing else.
echo "Granting passwordless stop/start for dump1090 only"
sudo tee "$SUDOERS" >/dev/null <<EOF
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop dump1090-mutability.service
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl start dump1090-mutability.service
EOF
sudo chmod 0440 "$SUDOERS"
sudo visudo -cf "$SUDOERS" >/dev/null || { echo "sudoers file is invalid; removing" >&2; sudo rm -f "$SUDOERS"; exit 1; }

sudo systemctl daemon-reload
sudo systemctl enable --now classg-sweep-agent.service

echo
systemctl status classg-sweep-agent.service --no-pager | head -6 || true
echo
echo "A sweep stops dump1090 for its duration. ADS-B is blind until it returns;"
echo "the agent restarts it in a trap, so it comes back even if a sweep fails."
echo
echo "Watch it:    journalctl -t classg-sweep-agent -f"
echo "Turn it off: sudo systemctl disable --now classg-sweep-agent.service"

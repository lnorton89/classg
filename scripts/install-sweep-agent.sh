#!/usr/bin/env bash
# Install the sweep agent, so the Spectrum page works.
#
# The API cannot sweep from inside its container -- no sensor binary, no
# /dev/bus/usb, no librtlsdr. This puts the work on the host, where the radio
# and the privileges already are.

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
SUDOERS=/etc/sudoers.d/classg-sweep-agent
SDR_BIN="$REPO_DIR/services/sensor-sdr/target/release/classg-sensor-sdr"

[ -d "$REPO_DIR/.git" ] || { echo "no checkout at $REPO_DIR" >&2; exit 1; }

echo "Installing the sweep agent from $REPO_DIR"

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

render_unit classg-sweep-agent.service

# Exactly the two commands a sweep needs to borrow the radio, and nothing else.
echo "Granting passwordless stop/start for dump1090 only"
# The grant goes to the unit's User= (the checkout owner), which is not
# necessarily whoever ran this installer.
sudo tee "$SUDOERS" >/dev/null <<EOF
$RUNAS ALL=(root) NOPASSWD: /usr/bin/systemctl stop dump1090-mutability.service
$RUNAS ALL=(root) NOPASSWD: /usr/bin/systemctl start dump1090-mutability.service
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

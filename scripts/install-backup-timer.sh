#!/usr/bin/env bash
# Install the hourly database snapshot on this unit.
#
# Separate from the watchdog and auto-deploy installers for the same reason
# those are separate from each other: it is a different decision. This one is
# the answer to "what happens when the SD card dies", and on a unit with no
# Turso sync configured -- the default -- it is the only answer there is.
#
# Read the warning it prints at the end. A snapshot sitting on the same card as
# the database it came from survives a corrupted table and does not survive the
# card. Pointing CLASSG_BACKUP_DIR at a USB stick is the difference.

set -euo pipefail

# Derived from this script's own location, not $HOME: run under sudo, $HOME is
# /root and the checkout is not there. Same reasoning as install-watchdog.sh.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CLASSG_REPO_DIR:-$(cd "$HERE/.." && pwd)}"
UNIT_DIR=/etc/systemd/system

BACKUP_DIR="${CLASSG_BACKUP_DIR:-}"
BACKUP_KEEP="${CLASSG_BACKUP_KEEP:-48}"

[ -d "$REPO_DIR/.git" ] || { echo "no checkout at $REPO_DIR" >&2; exit 1; }

RUNAS="$(stat -c %U "$REPO_DIR")"
if [ -z "$RUNAS" ] || [ "$RUNAS" = "UNKNOWN" ]; then
    RUNAS="${SUDO_USER:-$USER}"
fi

# The default has to be somewhere the unit's user can write without sudo, since
# the service runs unprivileged. Their home is that place.
if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="$(getent passwd "$RUNAS" | cut -d: -f6)/classg-backups"
fi

command -v sqlite3 >/dev/null || {
    echo "sqlite3 is required: sudo apt-get install -y sqlite3" >&2
    exit 1
}

echo "Installing hourly snapshots from $REPO_DIR"
echo "  destination: $BACKUP_DIR"
echo "  keeping:     $BACKUP_KEEP snapshots"

install -d -o "$RUNAS" -m 0755 "$BACKUP_DIR" 2>/dev/null \
    || sudo install -d -o "$RUNAS" -m 0755 "$BACKUP_DIR"

tmp="$(mktemp)"
sed -e "s|@CLASSG_HOME@|$REPO_DIR|g" \
    -e "s|@RUNAS@|$RUNAS|g" \
    -e "s|@BACKUP_DIR@|$BACKUP_DIR|g" \
    -e "s|@BACKUP_KEEP@|$BACKUP_KEEP|g" \
    "$REPO_DIR/deploy/systemd/classg-backup.service.in" > "$tmp"
sudo install -m 0644 "$tmp" "$UNIT_DIR/classg-backup.service"
rm -f "$tmp"

sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-backup.timer" "$UNIT_DIR/"

sudo systemctl daemon-reload
sudo systemctl enable --now classg-backup.timer

# Take one now rather than waiting up to an hour to discover the install is
# broken. An installer that reports success and produces nothing for an hour is
# how a unit ends up with no backups and an operator who believes otherwise.
echo
echo "Taking the first snapshot now, so a failure surfaces here and not in an hour"
if sudo systemctl start classg-backup.service; then
    sudo systemctl status classg-backup.service --no-pager -n 5 || true
fi

echo
systemctl list-timers classg-backup.timer --no-pager || true
echo
echo "Snapshots:       ls -lh $BACKUP_DIR"
echo "Run one now:     ./scripts/backup-db.sh"
echo "Watch it:        journalctl -u classg-backup.service -f"
echo "Turn it off:     sudo systemctl disable --now classg-backup.timer"
echo
echo "!! $BACKUP_DIR is on the same card as the database. That protects you"
echo "!! from a corrupted table and NOT from the card failing, which is the"
echo "!! failure that actually loses the flights. Copy snapshots off the unit:"
echo "!!     rsync -a $RUNAS@\$(hostname):$BACKUP_DIR/ ~/classg-backups/"
echo "!! or re-run with CLASSG_BACKUP_DIR pointing at mounted external storage."

#!/usr/bin/env bash
# Install the hourly database snapshot on this unit.
#
# Separate from the watchdog and auto-deploy installers for the same reason
# those are separate from each other: it is a different decision. This one is
# the answer to "what happens when the SD card dies", and on a unit with no
# Turso sync configured -- the default -- it is the only answer there is.
#
# Two modes, because unlike the other installers this one does not need root
# for anything except writing to /etc/systemd/system:
#
#   system (default)  a unit in /etc/systemd/system, matching every other
#                     classg timer. Needs sudo.
#   --user            a unit in ~/.config/systemd/user with lingering enabled
#                     so it runs with nobody logged in. Needs no password.
#
# The second exists because the snapshot itself needs no privilege at all --
# `docker cp` reaches the volume through the daemon -- so requiring a sudo
# password to install it would be the only privileged thing about it. On a unit
# administered over SSH with no TTY, that is the difference between hourly
# backups and no backups.
#
# Read the warning it prints at the end. A snapshot sitting on the same card as
# the database it came from survives a corrupted table and does not survive the
# card. Pointing CLASSG_BACKUP_DIR at a USB stick is the difference.

set -euo pipefail

MODE=system
for arg in "$@"; do
    case "$arg" in
        --user)   MODE=user ;;
        --system) MODE=system ;;
        -h|--help)
            echo "usage: $0 [--user|--system]"
            exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 1 ;;
    esac
done

# Derived from this script's own location, not $HOME: run under sudo, $HOME is
# /root and the checkout is not there. Same reasoning as install-watchdog.sh.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CLASSG_REPO_DIR:-$(cd "$HERE/.." && pwd)}"

BACKUP_DIR="${CLASSG_BACKUP_DIR:-}"
BACKUP_KEEP="${CLASSG_BACKUP_KEEP:-48}"

[ -d "$REPO_DIR/.git" ] || { echo "no checkout at $REPO_DIR" >&2; exit 1; }

RUNAS="$(stat -c %U "$REPO_DIR")"
if [ -z "$RUNAS" ] || [ "$RUNAS" = "UNKNOWN" ]; then
    RUNAS="${SUDO_USER:-$USER}"
fi

# The default has to be somewhere the unit's user can write without sudo, since
# the service runs unprivileged in both modes. Their home is that place.
if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="$(getent passwd "$RUNAS" | cut -d: -f6)/classg-backups"
fi

command -v sqlite3 >/dev/null || {
    echo "sqlite3 is required: sudo apt-get install -y sqlite3" >&2
    exit 1
}

# Said before doing anything rather than after failing: a sudo prompt with no
# TTY produces "a terminal is required to read the password", which reads as a
# broken script rather than a solvable one.
if [ "$MODE" = system ] && ! sudo -n true 2>/dev/null; then
    echo "This needs sudo to write /etc/systemd/system, and sudo wants a password" >&2
    echo "that it cannot ask for here. Either run it from a login shell, or use:" >&2
    echo "    $0 --user" >&2
    exit 1
fi

echo "Installing hourly snapshots from $REPO_DIR ($MODE mode)"
echo "  destination: $BACKUP_DIR"
echo "  keeping:     $BACKUP_KEEP snapshots"

if [ "$MODE" = user ]; then
    install -d -m 0755 "$BACKUP_DIR"
else
    install -d -o "$RUNAS" -m 0755 "$BACKUP_DIR" 2>/dev/null \
        || sudo install -d -o "$RUNAS" -m 0755 "$BACKUP_DIR"
fi

render() {
    sed -e "s|@CLASSG_HOME@|$REPO_DIR|g" \
        -e "s|@RUNAS@|$RUNAS|g" \
        -e "s|@BACKUP_DIR@|$BACKUP_DIR|g" \
        -e "s|@BACKUP_KEEP@|$BACKUP_KEEP|g" \
        "$REPO_DIR/deploy/systemd/classg-backup.service.in"
}

if [ "$MODE" = user ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    # User= is meaningless in a user unit and systemd refuses the unit outright
    # rather than ignoring it, so it comes out here.
    render | grep -v '^User=' > "$UNIT_DIR/classg-backup.service"
    cp "$REPO_DIR/deploy/systemd/classg-backup.timer" "$UNIT_DIR/"

    # Without lingering the user manager stops when the last SSH session ends,
    # and a timer that only runs while someone is logged in is not a backup.
    loginctl enable-linger "$RUNAS" 2>/dev/null \
        || echo "  (could not enable lingering; snapshots will only run while logged in)"

    SCTL=(systemctl --user)
else
    UNIT_DIR=/etc/systemd/system
    tmp="$(mktemp)"
    render > "$tmp"
    sudo install -m 0644 "$tmp" "$UNIT_DIR/classg-backup.service"
    rm -f "$tmp"
    sudo install -m 0644 "$REPO_DIR/deploy/systemd/classg-backup.timer" "$UNIT_DIR/"
    SCTL=(sudo systemctl)
fi

"${SCTL[@]}" daemon-reload
"${SCTL[@]}" enable --now classg-backup.timer

# Take one now rather than waiting up to an hour to discover the install is
# broken. An installer that reports success and produces nothing for an hour is
# how a unit ends up with no backups and an operator who believes otherwise.
echo
echo "Taking the first snapshot now, so a failure surfaces here and not in an hour"
if "${SCTL[@]}" start classg-backup.service; then
    "${SCTL[@]}" status classg-backup.service --no-pager -n 5 || true
fi

echo
"${SCTL[@]}" list-timers classg-backup.timer --no-pager || true
echo
echo "Snapshots:       ls -lh $BACKUP_DIR"
echo "Run one now:     ./scripts/backup-db.sh"
if [ "$MODE" = user ]; then
    echo "Watch it:        journalctl --user -u classg-backup.service -f"
    echo "Turn it off:     systemctl --user disable --now classg-backup.timer"
else
    echo "Watch it:        journalctl -u classg-backup.service -f"
    echo "Turn it off:     sudo systemctl disable --now classg-backup.timer"
fi
echo
echo "!! $BACKUP_DIR is on the same card as the database. That protects you"
echo "!! from a corrupted table and NOT from the card failing, which is the"
echo "!! failure that actually loses the flights. Copy snapshots off the unit:"
echo "!!     rsync -a $RUNAS@\$(hostname):$BACKUP_DIR/ ~/classg-backups/"
echo "!! or re-run with CLASSG_BACKUP_DIR pointing at mounted external storage."

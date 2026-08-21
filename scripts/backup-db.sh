#!/usr/bin/env bash
# Take a verified, self-contained snapshot of the ClassG database.
#
# This is the backup path for a unit that does NOT sync to Turso, which is the
# default and, after 2026-08-20, how this deployment runs. The sky does not
# re-run: a detection that is only on the SD card is one card failure away from
# never having happened ([ADR-0006](../docs/architecture/adr/0006-storage-turso-libsql.md)).
#
# Three constraints shaped how it works, and they rule out the obvious methods:
#
#   No downtime. Stopping the api container to copy the file is the easy
#   consistent snapshot, and it is wrong here -- the API is the process
#   subscribed to the sensor bus, so every second it is down is detections that
#   are never recorded by anyone. A backup that loses data to run is not a
#   backup.
#
#   No network. A field unit has no uplink, so anything that starts with
#   `apk add sqlite` fails exactly when it is needed most. Only images already
#   on the box may be used.
#
#   No root. The volume lives under /var/lib/docker, which needs a password
#   this script will not have when systemd runs it on a timer. `docker cp`
#   reaches the same bytes through the daemon and needs only docker group
#   membership, which the operator already has.
#
# So: copy the files out through `docker cp`, then let sqlite3 on the host do
# the real work. Copying a live WAL database file-by-file can in principle tear
# -- a checkpoint landing between the two reads -- so the copy is not trusted.
# It is checked with `PRAGMA integrity_check` and a row count before anything
# is kept, and retried if it fails. At ~22MB the copy takes well under a second,
# so a tear is rare and a retry is cheap. What gets kept is the output of
# `VACUUM INTO`, which is a single compact file with no sidecars: the thing you
# actually want to find on a USB stick a year from now.

set -uo pipefail

BACKUP_DIR="${CLASSG_BACKUP_DIR:-$HOME/classg-backups}"
KEEP="${CLASSG_BACKUP_KEEP:-14}"
CONTAINER="${CLASSG_API_CONTAINER:-classg-api}"
DB_IN_CONTAINER="${CLASSG_DB_PATH:-/data/classg.db}"
ATTEMPTS=3

die() { echo "backup-db: $*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
command -v sqlite3 >/dev/null || die "sqlite3 not found (apt-get install sqlite3)"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no container named $CONTAINER"

mkdir -p "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP="$BACKUP_DIR/classg-$STAMP.db"
WORK="$(mktemp -d)" || die "cannot create a work directory"
trap 'rm -rf "$WORK"' EXIT

# Row counts are the difference between "a file exists" and "a backup exists".
# Reported for both, and compared, so a snapshot that silently lost the history
# fails the run instead of rotating a good one out.
count_rows() {
    sqlite3 "$1" "select count(*) from detections" 2>/dev/null || echo "-1"
}

ok=""
for attempt in $(seq 1 "$ATTEMPTS"); do
    rm -f "$WORK"/classg.db*

    # The order matters. Copying the database before the WAL can only leave the
    # WAL holding frames newer than the database, which is the state SQLite
    # recovers from on every unclean shutdown. The other order can produce a
    # WAL older than the database it is replayed against, which is corruption.
    docker cp "$CONTAINER:$DB_IN_CONTAINER" "$WORK/classg.db" >/dev/null 2>&1 || {
        echo "backup-db: attempt $attempt: could not copy the database" >&2
        continue
    }
    docker cp "$CONTAINER:$DB_IN_CONTAINER-wal" "$WORK/classg.db-wal" >/dev/null 2>&1 || true

    check="$(sqlite3 "$WORK/classg.db" "pragma integrity_check" 2>&1 | head -1)"
    if [ "$check" != "ok" ]; then
        echo "backup-db: attempt $attempt: integrity check said '$check', retrying" >&2
        sleep 2
        continue
    fi

    # VACUUM INTO writes one file with the WAL already folded in, so the result
    # needs no sidecars and no recovery to open. Restoring is a copy.
    if ! sqlite3 "$WORK/classg.db" "vacuum into '$SNAP'" 2>"$WORK/err"; then
        echo "backup-db: attempt $attempt: vacuum failed: $(cat "$WORK/err")" >&2
        rm -f "$SNAP"
        sleep 2
        continue
    fi

    src="$(count_rows "$WORK/classg.db")"
    dst="$(count_rows "$SNAP")"
    if [ "$dst" -lt 0 ] || [ "$dst" -ne "$src" ]; then
        echo "backup-db: attempt $attempt: snapshot has $dst detections, source has $src" >&2
        rm -f "$SNAP"
        sleep 2
        continue
    fi
    ok="yes"
    break
done

[ -n "$ok" ] || die "no verified snapshot after $ATTEMPTS attempts; nothing was rotated"

gzip -f "$SNAP" || die "snapshot written but gzip failed: $SNAP"
SNAP="$SNAP.gz"
size="$(du -h "$SNAP" | cut -f1)"
echo "backup-db: $SNAP ($size, $dst detections)"

# Rotate only after a good snapshot exists. A failed run leaves every previous
# backup in place, which is the behaviour you want at 3am: the worst case is an
# old backup, never no backup.
#
# Sorted by a glob rather than by mtime: the stamp is UTC and fixed-width, so
# lexicographic order is chronological order, and it stays correct across a
# restore that resets every file's mtime to the day it was copied back.
shopt -s nullglob
snaps=("$BACKUP_DIR"/classg-*.db.gz)
shopt -u nullglob
if [ "${#snaps[@]}" -gt "$KEEP" ]; then
    prune=$(( ${#snaps[@]} - KEEP ))
    rm -f "${snaps[@]:0:$prune}"
    echo "backup-db: pruned $prune snapshot(s) beyond the newest $KEEP"
fi

# The capture corpus and .env are on the card too and are not in the database.
# Saying so here is the only place an operator reliably reads it.
echo "backup-db: reminder -- captures/ and .env are NOT in this snapshot"

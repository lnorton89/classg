#!/usr/bin/env python3
"""Seed an empty Turso database from a `sqlite3 .dump`, over the HTTP API.

Needed once, on a unit that was running before Turso was configured. A libSQL
embedded replica keeps sidecar metadata beside the database, and an ordinary
SQLite file has none, so pointing the API at an existing database fails with:

    sync error: invalid local state: db file exists but metadata file does not

The fix is to push the existing data up first and let the replica pull it back
down -- see docs/ops/13-backup-and-restore.md, which has the surrounding steps.
Deleting the local database instead loses the operator accounts along with the
history and leaves the unit at its first-run setup screen.

Statements are split with sqlite3.complete_statement rather than on ";",
because a semicolon inside a string literal would otherwise cut one in half --
and the rows carrying raw frame payloads are exactly the ones that contain
them.

Standard library only: this runs on the Pi, which has no pip environment for
one-off operational scripts.

    ./scripts/seed-turso.py <dump.sql> <host> <token>

where <host> is the CLASSG_TURSO_URL without the libsql:// scheme.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import urllib.request
from collections.abc import Iterator

# Large enough that 13k statements is ~90 requests rather than thousands, small
# enough that one rejected statement names a short batch.
BATCH = 150

# A .dump wraps everything in a transaction and sets a pragma. The pipeline API
# runs each statement on its own, and rejects both.
SKIP_PREFIXES = ("PRAGMA", "BEGIN TRANSACTION", "COMMIT")


def statements(path: str) -> Iterator[str]:
    buf = ""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            buf += line
            if sqlite3.complete_statement(buf):
                stmt = buf.strip()
                buf = ""
                if stmt and not stmt.upper().startswith(SKIP_PREFIXES):
                    yield stmt
    if buf.strip():
        yield buf.strip()


def send(host: str, token: str, batch: list[str]) -> None:
    body = {"requests": [{"type": "execute", "stmt": {"sql": s}} for s in batch]}
    body["requests"].append({"type": "close"})
    req = urllib.request.Request(
        f"https://{host}/v2/pipeline",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())
    for result in out.get("results", []):
        if result.get("type") == "error":
            # Stop rather than press on: a partially seeded database that looks
            # complete is worse than an obvious failure.
            raise SystemExit("Turso rejected a statement: " + json.dumps(result["error"])[:400])


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    dump, host, token = sys.argv[1], sys.argv[2], sys.argv[3]

    batch: list[str] = []
    sent = 0
    for stmt in statements(dump):
        batch.append(stmt)
        if len(batch) >= BATCH:
            send(host, token, batch)
            sent += len(batch)
            batch = []
            print(f"  {sent} statements", flush=True)
    if batch:
        send(host, token, batch)
        sent += len(batch)
    print(f"done: {sent} statements applied")


if __name__ == "__main__":
    main()

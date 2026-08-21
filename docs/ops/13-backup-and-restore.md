# Backup, restore, and uninstall

What survives losing the SD card, how to make that answer better than
"nothing", and how to take ClassG off a machine cleanly.

## What there is to lose

One file: `classg.db`, in the `classg-data` Docker volume
(`/data/classg.db` inside the api container). It holds the detection and
track history, accounts and sessions, the settings database that is
authoritative over the YAML seed, hook configuration and delivery history,
and sweep results. [ADR-0006](../architecture/adr/0006-storage-turso-libsql.md)
is blunt about why it matters: the sky does not re-run, so recorded
detections cannot be regenerated from anything.

**The default posture, stated plainly: with `CLASSG_TURSO_URL` empty — which
is how a fresh install comes up — the SD card is the only copy of everything
above.** On this unit the `classg-data` volume was created fresh on
2026-08-16, so nothing older than that exists anywhere in any case.

**This unit, as of 2026-08-20:** Turso sync is **off**, and hourly local
snapshots are on. Sync was disabled because the mode it ran in put every
write on the network — see [the ADR's correction
note](../architecture/adr/0006-storage-turso-libsql.md) — and turning it off
took end-to-end detection latency from a median of 86s to 0.5s. The
credentials are still in `.env`, commented, if you want it back.

Also on the card and *not* in the database: the capture corpus in
`captures/` (gitignored, per its README), and `.env` with its secrets.

## Hourly local snapshots

The default backup path, and the only one that needs no account, no
credentials and no uplink.

```bash
./scripts/install-backup-timer.sh
```

That installs a systemd timer that runs [`scripts/backup-db.sh`](../../scripts/backup-db.sh)
every hour, keeps the newest 48, and takes one immediately so a broken
install fails in front of you instead of silently an hour later. Each
snapshot is a single self-contained file — no `-wal`, no `-info`, nothing to
recover — produced with `VACUUM INTO` and checked with `PRAGMA
integrity_check` and a row count before it is kept. Measured on this unit: a
22MB database takes 3.4s and compresses to ~3MB.

It does **not** stop the api container to do this. That matters more than it
sounds: the API is the process subscribed to the sensor bus, so a backup that
takes the API down is a backup that costs you detections every time it runs.

Run one by hand any time:

```bash
./scripts/backup-db.sh                          # -> ~/classg-backups
CLASSG_BACKUP_DIR=/mnt/usb ./scripts/backup-db.sh
```

### The part that is easy to skip

A snapshot in `~/classg-backups` is on the same SD card as the database it
came from. **That protects you from a corrupted table and not from the card
failing**, and the card is what actually fails. Either point
`CLASSG_BACKUP_DIR` at mounted external storage, or pull them off on a
schedule from somewhere else:

```bash
rsync -a admin@pisdr:classg-backups/ ~/classg-backups/
```

### Restoring one

```bash
gunzip -k classg-20260821T012139Z.db.gz
docker compose --env-file .env -f docker/docker-compose.yml stop api
docker cp classg-20260821T012139Z.db classg-api:/data/classg.db
docker exec classg-api sh -c 'rm -f /data/classg.db-wal /data/classg.db-shm /data/classg.db-info'
docker compose --env-file .env -f docker/docker-compose.yml start api
```

Removing the sidecars matters: a stale `-wal` replayed against a database it
does not belong to is corruption, and a leftover `-info` makes the store
think it is still a replica of a database it no longer matches.

Check what you are about to restore *before* you overwrite anything —
`users` at zero means restoring puts you back at the first-run setup screen
with no way in:

```bash
sqlite3 classg-20260821T012139Z.db \
  'select (select count(*) from detections), (select count(*) from tracks), (select count(*) from users)'
```

## Off-site replication with Turso (optional)

Snapshots handle a dead card only if you have moved them off the card.
Replication does that continuously, without anyone remembering to.

> **Read this before enabling it.** Use a build that opens the database with
> `NewSyncedDatabaseConnector`. The similarly named `NewEmbeddedReplicaConnector`
> — which this repo used until 2026-08-20 — writes **through to the remote
> primary**, so every detection insert becomes an internet round trip and the
> local file is only a read cache. On this unit that measured ~250ms per
> insert, a 42s API startup, and detections surfacing 86s late while heartbeats
> starved behind them. The
> [ADR](../architecture/adr/0006-storage-turso-libsql.md) has the detail.

The compose file already passes the three variables through; configuring it
is filling them in.

### 1. Create the database

On a workstation with the [`turso` CLI](https://docs.turso.tech/) (the Pi
does not need it):

```bash
turso db create classg
turso db show classg --url        # -> libsql://classg-<org>.turso.io
turso db tokens create classg     # -> the auth token
```

The Turso docs are the reference for account setup and token scopes; the
three commands above are the whole requirement.

### 2. Configure the unit

In the Pi's `.env` — these are Tier 1 secrets
([ADR-0007](../architecture/adr/0007-configuration-tiers.md)), so `.env` is
the only right place for them:

```dotenv
CLASSG_TURSO_URL=libsql://classg-<org>.turso.io
CLASSG_TURSO_AUTH_TOKEN=<token>
# CLASSG_TURSO_SYNC_INTERVAL=1m    # the default
```

Then recreate the api container so it sees the new environment — a restart
is not enough, the environment is fixed at creation, and `--force-recreate`
because Compose will otherwise reuse the old container's environment even
while reporting "Recreated":

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d --force-recreate api
```

### 2a. Seeding a unit that already has data

**A database created before you configured Turso cannot simply become a
replica.** A replica keeps sidecar metadata next to the database (`classg.db-info`),
and an ordinary SQLite file has none, so the API reports:

```
sync error: invalid local state: db file exists but metadata file does not
```

Skip this section on a fresh unit — there is nothing to preserve, and step 2
is enough. On a unit that has been running, the existing database holds your
**operator accounts** as well as the detection history, so do not simply
delete it: a fresh replica syncing down from an empty Turso database leaves
you at the first-run setup screen with no way back in.

Seed Turso from the existing database first, then let the replica pull it
back down. This needs only `sqlite3` and `curl`:

```bash
# 1. Dump the live database from a copy, so a writer cannot tear the dump.
docker run --rm -v classg-data:/d -v /tmp:/out alpine sh -c   'apk add --no-cache sqlite >/dev/null && cp /d/classg.db /tmp/s.db &&    sqlite3 /tmp/s.db .dump > /out/classg-dump.sql'

# 2. Push it to Turso over the HTTP pipeline API, in batches. Split the dump
#    with sqlite3.complete_statement rather than on ";" -- a semicolon inside a
#    string literal will otherwise cut a statement in half, and the rows that
#    carry raw frame payloads are exactly the ones that contain them.
#    scripts/seed-turso.py does this.
python3 scripts/seed-turso.py /tmp/classg-dump.sql "$HOST" "$TOKEN"

# 3. Back up and clear the volume so the replica can bootstrap clean.
docker compose --env-file .env -f docker/docker-compose.yml stop api
docker run --rm -v classg-data:/d -v "$BACKUP":/bk alpine cp -a /d/. /bk/
docker run --rm -v classg-data:/d alpine sh -c 'rm -f /d/classg.db*'

# 4. Start it. The replica pulls everything back down.
docker compose --env-file .env -f docker/docker-compose.yml up -d --force-recreate api
```

Confirm `classg.db-info` now exists in the volume and that your accounts came
back before deleting the backup.

### 3. Verify it is actually flowing

A backup nobody has verified is a hope, not a backup. Three signals, in
order of increasing confidence:

```bash
docker logs classg-api 2>&1 | grep libSQL
```

- `libSQL synced database: writes are local, replicating to Turso` — sync is
  configured and the connector opened.
- `libSQL local database: no sync configured` — the variables did not reach
  the process; check `.env` and that the container was recreated.
- A typo'd URL **fails startup on purpose** rather than silently downgrading
  to local-only (`open libsql embedded replica against ...`); removing the
  URL is the documented way to ask for local-only.
- `initial Turso sync failed; continuing with the local database` — the unit
  keeps detecting (deliberate: a detector must record with the uplink down),
  but nothing is replicating. Fix the network or token before trusting it.

Then prove data lands remotely, from the workstation:

```bash
turso db shell classg "select count(*) from detections"
```

Run it, wait a sync interval or two while the unit is detecting (replay a
capture if the sky is quiet), run it again. The count moving is the
verification; everything before it was configuration.

### 4. Restore onto a fresh card

Provision the Pi as usual ([01](01-pi-setup.md) → [02](02-wifi-adapter.md) →
[03](03-sdr-setup.md) → [09](09-deployment.md)), restore `.env` with the
**same** `CLASSG_TURSO_URL` and token, and `make compose-up`. On first open
the store performs a synchronous initial sync before serving, so the replica
hydrates from Turso rather than starting empty. Verify with the same count
comparison as above, in the other direction.

Know the loss window: writes are local-first and replicate on the sync
interval (default 1 m), so a card that dies mid-outage takes with it
whatever accumulated since the last successful sync.

## What Turso does not protect

Replication covers the database and nothing else. A full recovery also
needs:

| Not replicated | Where it comes back from |
|---|---|
| `.env` — including the Turso token itself | Keep a copy somewhere safe (password manager, encrypted backup). Without it, re-mint the token and re-fill by hand |
| `captures/` PCAP corpus | Copy off the unit (`rsync`/`scp`); it exists nowhere else, by design |
| systemd units, sudoers drop-ins | Re-rendered by `deploy/systemd/install.sh` and `scripts/install-*.sh` from the checkout |
| udev rule, DVB-T blacklist, dump1090 setup | Redo [03-sdr-setup.md](03-sdr-setup.md) |
| monitor-mode / adapter host config | Redo [02-wifi-adapter.md](02-wifi-adapter.md) |
| `classg-tile-cache` volume | Refills itself from use; losing it costs bandwidth, not data |

## The cold copy, and why it is not the recipe here

Stopping the api container and taring the volume is the obvious backup, and
this document used to recommend it. It is correct and it is still the right
move for a one-off before something risky — but not on a timer, because the
API is the bus subscriber and every second it is stopped is detections nobody
records. `scripts/backup-db.sh` exists to get the same consistency without
the downtime.

If you want one anyway — before a migration, say:

```bash
docker compose --env-file .env -f docker/docker-compose.yml stop api
docker run --rm -v classg-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/classg-data-$(date +%Y%m%d).tgz -C /data .
docker compose --env-file .env -f docker/docker-compose.yml start api
```

Restore by unpacking into the volume before the api container's first start.

## Container logs and the card

`/etc/docker/daemon.json` on the unit caps container logs
(`max-size: 10m`, `max-file: 3`) so an unbounded log cannot fill the card.
The cap applies when a container is **created**: containers running from
before the change keep their uncapped logs until recreated, and a restart is
not a recreate. The next deploy (`compose up -d --build`, or the autodeploy
agent) picks it up. Set on this unit 2026-08-18.

## Uninstall

Everything the installers added, in reverse. The database deletion is the
irreversible line — everything above it is recoverable from the repo.

```bash
# host agents and sensors
sudo systemctl disable --now classg-watchdog.timer classg-autodeploy.timer \
  classg-backup.timer classg-sweep-agent.service classg-sensor-wifi classg-sensor-sdr
sudo rm -f /etc/systemd/system/classg-*.service /etc/systemd/system/classg-*.timer
sudo systemctl daemon-reload

# the narrow sudo grants
sudo rm -f /etc/sudoers.d/classg-watchdog /etc/sudoers.d/classg-sweep-agent \
  /etc/sudoers.d/classg-autodeploy

# web tier, then data -- THIS DELETES THE DATABASE
docker compose --env-file .env -f docker/docker-compose.yml down
docker volume rm classg-data classg-tile-cache
docker volume ls | grep classg     # dev-stack volumes, if the machine ran make dev

# the checkout, its venv, builds, captures and agent state
rm -rf ~/classg
```

Left in place on purpose, because they may serve other software: the
rtl-sdr udev rule (`/etc/udev/rules.d/rtl-sdr.rules`), the DVB-T blacklist
(`/etc/modprobe.d/classg-blacklist-rtl.conf` — this one is ClassG-named and
safe to remove if nothing else uses the dongle), `dump1090-mutability`, and
Docker itself. Remove them per [03-sdr-setup.md](03-sdr-setup.md) if the
radio is leaving with ClassG.

# Operational scripts

These Bash helpers support hardware bring-up and passive Wi-Fi capture. Run
them from the repository root on a Raspberry Pi, or any Linux host; most
commands that change an adapter's mode require `sudo`.

| Script | Purpose |
|---|---|
| `check-capture-env.sh [interface]` | Preflight driver, firmware, USB, monitor-mode, and capture-tool checks |
| `setup-monitor.sh [interface] [channel]` | Configure a Wi-Fi adapter for passive monitor mode |
| `first-capture.sh [interface] [channel\|sweep] [seconds]` | Record and triage the first beacon-only DJI capture |
| `diagnose-adapter.sh` | Reload and inspect the MT7921U adapter probe sequence |
| `usb-soak.sh [interval_s] [logfile]` | Sample both radios until one lets go — for the unexplained 4 h 11 min disconnect |

The Pi dashboard used to live here as `pi-dash.sh`. It is now
[tools/pi-dash](../tools/pi-dash), a Rust submodule -- one process rendering
its own panes rather than Bash driving tmux around `btop`. It still reads
`/proc`, `/sys` and `vcgencmd` directly and still runs unprivileged.

```bash
git submodule update --init tools/pi-dash
cd tools/pi-dash && cargo build --release
./target/release/pi-dash          # --once for a plain-text dump
```

The rest — `dev.sh`, `dev-preflight.sh`, `dev-sensor.sh`, `sensor-supervise.sh`,
`migrate-env.sh` — are plumbing for `make dev` / `make dev-native` /
`make migrate-env` and are not meant to be run directly.

Three more fetch optional offline reference data. Everything they download is
third-party, gitignored, and used only to enrich detections that already work
without it — see [docs/ops/07-external-data.md](../docs/ops/07-external-data.md).

| Script | Fetches |
|---|---|
| `fetch-oui-registry.sh [out]` | IEEE MA-L registry, for Wi-Fi vendor fingerprinting (`make data-oui`) |
| `fetch-aircraft-db.sh [out]` | OpenSky aircraft database, to name ADS-B contacts (`make data-aircraft`) |
| `fetch-basemap.sh <bbox> [z]` | A Protomaps `.pmtiles` basemap for the operator UI |

Two more keep the data alive. The database is the one thing on the card that
cannot be regenerated -- see
[docs/ops/13-backup-and-restore.md](../docs/ops/13-backup-and-restore.md).

| Script | Purpose |
|---|---|
| `backup-db.sh` | One verified, self-contained snapshot of the database, with no downtime |
| `install-backup-timer.sh` | Install that on an hourly systemd timer |

Start with:

```bash
./scripts/check-capture-env.sh wlan-alfa
sudo ./scripts/first-capture.sh wlan-alfa 6
```

`setup-monitor.sh` intentionally uses passive monitor mode. Do not switch the
MT7921U to active monitor mode: it can wedge the adapter, and ClassG never
transmits. See [the Wi-Fi setup guide](../docs/ops/02-wifi-adapter.md) and
[first-capture guide](../docs/ops/06-first-capture.md).

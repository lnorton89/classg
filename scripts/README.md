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
| `pi-dash.sh` | Tiled tmux dashboard: btop, Pi throttle/thermal state, radio link state, API health |

`pi-dash.sh` needs `tmux` and `btop`; everything else it shows it reads from
`/proc`, `/sys` and `vcgencmd`, so it runs unprivileged. `--install` drops a
`pidash` wrapper on `PATH` that keeps pointing at this checkout:

```bash
./scripts/pi-dash.sh --install   # then just: pidash
```

Three more fetch optional offline reference data. Everything they download is
third-party, gitignored, and used only to enrich detections that already work
without it — see [docs/ops/07-external-data.md](../docs/ops/07-external-data.md).

| Script | Fetches |
|---|---|
| `fetch-oui-registry.sh [out]` | IEEE MA-L registry, for Wi-Fi vendor fingerprinting (`make data-oui`) |
| `fetch-aircraft-db.sh [out]` | OpenSky aircraft database, to name ADS-B contacts (`make data-aircraft`) |
| `fetch-basemap.sh <bbox> [z]` | A Protomaps `.pmtiles` basemap for the operator UI |

Start with:

```bash
./scripts/check-capture-env.sh wlan1
sudo ./scripts/first-capture.sh wlan1 6
```

`setup-monitor.sh` intentionally uses passive monitor mode. Do not switch the
MT7921U to active monitor mode: it can wedge the adapter, and ClassG never
transmits. See [the Wi-Fi setup guide](../docs/ops/02-wifi-adapter.md) and
[first-capture guide](../docs/ops/06-first-capture.md).

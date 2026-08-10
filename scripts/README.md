# Operational scripts

These Bash helpers support hardware bring-up and passive Wi-Fi capture. Run
them from the repository root on Linux, a Raspberry Pi, or WSL as indicated;
most commands that change an adapter's mode require `sudo`.

| Script | Purpose |
|---|---|
| `check-capture-env.sh [interface]` | Preflight driver, firmware, USB, monitor-mode, and capture-tool checks |
| `setup-monitor.sh [interface] [channel]` | Configure a Wi-Fi adapter for passive monitor mode |
| `first-capture.sh [interface] [channel\|sweep] [seconds]` | Record and triage the first beacon-only DJI capture |
| `diagnose-adapter.sh` | Reload and inspect the MT7921U adapter probe sequence |
| `wsl-build-kernel.sh` | Build a WSL2 kernel with MT7921U support |

Start with:

```bash
./scripts/check-capture-env.sh wlan1
sudo ./scripts/first-capture.sh wlan1 6
```

`setup-monitor.sh` intentionally uses passive monitor mode. Do not switch the
MT7921U to active monitor mode: it can wedge the adapter, and ClassG never
transmits. See [the Wi-Fi setup guide](../docs/ops/02-wifi-adapter.md) and
[first-capture guide](../docs/ops/06-first-capture.md).

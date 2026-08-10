# sensor-wifi

The Wi-Fi sensor passively captures 802.11 beacon traffic, decodes ASTM F3411
Remote ID and DJI DroneID payloads, and can recognize lower-confidence vendor
fingerprints. It targets the MT7921AU-based ALFA AWUS036AXML in monitor mode.

## Install and test

```bash
cd services/sensor-wifi
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev,replay]'
.venv/bin/python -m pytest
```

## Commands

```bash
# Record beacon-only traffic; requires a monitor-mode interface and tcpdump.
.venv/bin/python -m classg_wifi.cli capture --iface wlan1 --out ../../captures/capture.pcap

# Decode a capture without hardware.
.venv/bin/python -m classg_wifi.cli replay ../../captures/capture.pcap

# Produce the calibration report used by the operating guide.
.venv/bin/python -m classg_wifi.cli analyze ../../captures/capture.pcap
```

`run` currently publishes an unhealthy heartbeat and exits only after shutdown:
the live raw-socket capture loop has not landed yet. Use `capture`, `replay`,
and `analyze` for the working Milestone 0/1 path.

Before a real capture, run [`../../scripts/check-capture-env.sh`](../../scripts/check-capture-env.sh)
and follow [the first-capture guide](../../docs/ops/06-first-capture.md). Capture
files can include nearby devices' traffic; keep them out of Git.

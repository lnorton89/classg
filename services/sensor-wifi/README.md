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
.venv/bin/python -m classg_wifi.cli capture --iface wlan-alfa --out ../../captures/capture.pcap

# Decode a capture without hardware.
.venv/bin/python -m classg_wifi.cli replay ../../captures/capture.pcap

# Produce the calibration report used by the operating guide.
.venv/bin/python -m classg_wifi.cli analyze ../../captures/capture.pcap
```

`run` is the live sensor: raw-socket capture on a monitor-mode interface,
weighted channel hopping, and detections plus heartbeats published on the bus.
It needs root (AF_PACKET) and monitor mode already set — from the repo root,
`make monitor` then `make sense`. Deployed units run it under systemd instead
([docs/ops/09-deployment.md](../../docs/ops/09-deployment.md)); note the socket
mode defaults to `bind`, which is right all-native and wrong when fusion is in
Compose — set `CLASSG_WIFI_SOCKET_MODE=connect` there.

Before a real capture, run [`../../scripts/check-capture-env.sh`](../../scripts/check-capture-env.sh)
and follow [the first-capture guide](../../docs/ops/06-first-capture.md). Capture
files can include nearby devices' traffic; keep them out of Git.

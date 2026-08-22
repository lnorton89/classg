# Captures

**Gitignored by default. Keep it that way.**

Monitor mode captures *every* 802.11 frame in range, not just drone beacons. Your neighbours'
networks and devices are in these files. Treat any full capture as sensitive, and delete
debugging captures when you're done with them.
See [legal-and-ethics.md](../docs/research/06-legal-and-ethics.md#privacy-of-your-own-capture).

## What to capture, and why

Milestone 0's exit criterion is a PCAP of your DJI. Everything downstream — every parser
offset, every calibration constant, every regression test — is built against it.

```bash
sudo tcpdump -i wlan-alfa -w captures/dji-first-flight.pcap "type mgt subtype beacon"
```

Power on the drone → let it acquire GPS → hover → land. Then in Wireshark:

- `wlan.tag.number == 221` — vendor-specific IEs
- Look for OUI `26:37:12` (DJI DroneID) and `fa:0b:bc` (ASTM F3411 Remote ID)

## Naming

```
<date>-<model>-<firmware>-<scenario>.pcap

2026-08-10-mini3pro-01.00.0500-first-flight.pcap
2026-08-10-mini3pro-01.00.0500-range-walk.pcap
2026-08-10-negative-control-no-drone.pcap
```

Firmware version in the filename is not pedantry: DJI has shipped firmware that moves DroneID
field offsets, so a capture is only meaningful alongside the firmware that produced it.

## Priority captures

| Capture | Why |
|---|---|
| First flight | Ground truth for every parser offset |
| **Negative control (no drone, 1 h)** | Measures the false-positive rate — test T7. Most projects never do this, which is why they claim detection rates nobody has verified. |
| Range walk | The real coverage curve — RSSI vs reported GPS distance |
| Occlusion | Track continuity through line-of-sight loss (T5) |

## Test vectors

Once a capture yields verified drone frames, extract the individual IEs into
`services/sensor-wifi/tests/vectors/`. Those **are** committed — they're small, contain no
third-party traffic, and form the regression net that catches parser changes altering
detection counts on known-good data.

# sensor-ble (Python) — Milestone 4

Not yet implemented. **Requires hardware you don't currently own.**

## Why this matters

ASTM F3411 defines four transports. A meaningful share of Remote ID traffic is **Bluetooth
only** — many compliant drones and most retrofit broadcast modules never touch Wi-Fi. Without
this sensor, ClassG is blind to them.

## Why the ALFA can't do it

The AWUS036AXML has Bluetooth 5.2, but:

1. Receiving **LE Coded PHY** (Long Range) extended advertising requires controller support
   that ordinary BT adapters, including this one, generally lack.
2. On kernels 6.6+, the MT7921's BT sharing a USB device with `mt7921u` causes sporadic Wi-Fi
   crashes — so `btusb` is disabled for that adapter anyway.
   See [02-wifi-adapter.md](../../docs/ops/02-wifi-adapter.md).

## Hardware

**nRF52840 dongle** (~$10–25) flashed with [Sniffle](https://github.com/nccgroup/Sniffle).
Sonoff CC2652P also works. Highest detection-coverage-per-dollar upgrade available for this
project.

## Design

Reuse `classg_wifi.parsers.odid` unchanged — the ASTM F3411 payload is identical across
transports, only the encapsulation differs:

| Transport | Encapsulation |
|---|---|
| BT4 Legacy | AD type Service Data, UUID `0xFFFA`, one 25-byte message per advert |
| BT5 Extended | LE Coded PHY S2/S8, Message Pack |

Emits Class G detections (weight 0.60, same as Class A — same payload semantics).

**The dedup test matters most:** a drone broadcasting on both Wi-Fi and BLE must produce
**one** track, not two. Fusion already keys on serial number across transports, so this should
work — but it must be verified, and it's the exit criterion for Milestone 4.

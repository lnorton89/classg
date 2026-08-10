# ClassG

[![CI](https://github.com/lnorton89/classg/actions/workflows/ci.yml/badge.svg)](https://github.com/lnorton89/classg/actions/workflows/ci.yml)

Passive, multi-sensor drone detection for a Raspberry Pi.

Named for [Class G airspace](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap3_section_1.html) —
the uncontrolled airspace below ~1200 ft AGL where nearly all drone activity happens and
where almost nobody is watching.

**ClassG is receive-only.** It never transmits, never jams, never spoofs, never takes over a
drone. See [docs/research/06-legal-and-ethics.md](docs/research/06-legal-and-ethics.md) — this
is a design constraint, not a disclaimer.

---

## What this actually detects

The single most important fact about this hardware, stated up front:

> **An RTL-SDR V4 tunes 500 kHz – 1.766 GHz. DJI drones talk on 2.4 GHz and 5.8 GHz.
> The SDR cannot see your DJI. Not with a better antenna, not with more gain, not ever.**

So the two radios do genuinely different jobs:

| Radio | Job | Sees your DJI? |
|---|---|---|
| **ALFA AWUS036AXML** (MT7921AU) | Wi-Fi Remote ID + DJI DroneID beacons | **Yes — this is the DJI sensor** |
| **RTL-SDR V4** (R828D) | Sub-2 GHz control links, analog FPV video, ADS-B airspace context, GNSS interference | No |

Full band-by-band breakdown: [docs/research/02-hardware-capabilities.md](docs/research/02-hardware-capabilities.md)

### Detection classes

| Class | Signal | Sensor | Status |
|---|---|---|---|
| A | ASTM F3411 Remote ID, Wi-Fi Beacon | Wi-Fi | Milestone 1 |
| B | DJI DroneID, Wi-Fi vendor IE (OUI `26:37:12`) | Wi-Fi | Milestone 1 |
| C | Wi-Fi OUI / SSID fingerprint (DJI, Autel, Parrot, Skydio) | Wi-Fi | Milestone 1 |
| D | ADS-B manned traffic (correlation + false-positive suppression) | SDR | Milestone 2 |
| E | 433 / 868 / 915 MHz control links (ELRS, Crossfire, RFD900) | SDR | Milestone 3 |
| F | 1.2 / 1.3 GHz analog FPV video downlink | SDR | Milestone 3 |
| G | ASTM F3411 Remote ID over Bluetooth LE | *add-on dongle* | Milestone 4 |
| H | GNSS L1 noise floor / interference indicator | SDR | Backlog |

Class G needs hardware you don't have yet — see
[docs/research/02-hardware-capabilities.md#the-bluetooth-gap](docs/research/02-hardware-capabilities.md#the-bluetooth-gap).
It matters: a meaningful share of Remote ID traffic is Bluetooth-only.

---

## Architecture in one picture

```
 ALFA AXML ──► sensor-wifi   (Python)  ─┐
 RTL-SDR   ──► sensor-sdr    (Rust)    ─┼─► ZeroMQ PUB ─► fusion (Go) ─► api (Go) ─► ui (Vite)
 [BLE dongle] ► sensor-ble   (Python)  ─┘      tcp://…:5556      tracks     REST+WS      map
```

Each sensor is an isolated process that emits **Detections**. Fusion correlates them into
**Tracks**. One sensor crashing, or its USB device vanishing, degrades the system instead of
killing it. Rationale: [ADR-0003](docs/architecture/adr/0003-sensor-process-isolation.md).

Why four languages: [ADR-0001](docs/architecture/adr/0001-language-split.md). Short version —
Python where the protocol churn is, Rust where the samples are, Go where the concurrency is,
Node where the map is.

---

## Repository layout

```
classg/
├── docs/
│   ├── research/       Band plans, protocol formats, prior art, legal
│   ├── architecture/   System design, data model, ADRs
│   ├── planning/       Roadmap, milestones, test plan
│   └── ops/            Pi setup, adapter setup, troubleshooting
├── schemas/            JSON Schema — the cross-language contract
├── services/
│   ├── sensor-wifi/    Python: monitor mode, channel hopping, frame parsing
│   ├── sensor-sdr/     Rust: IQ streaming, FFT, energy detection
│   ├── sensor-ble/     Python: BlueZ / Sniffle BLE Remote ID
│   ├── fusion/         Go: detection→track correlation, scoring
│   ├── api/            Go: REST + WebSocket
│   └── ui/             Vite + MapLibre
├── captures/           PCAP / IQ corpus (gitignored, see captures/README.md)
├── scripts/            Bring-up and diagnostic helpers
└── docker/             Compose for dev; see docs/ops for USB caveats
```

---

## Quickstart

Nothing is built yet — this repo currently contains the design, the schemas, and skeleton
services. Start here:

1. **Read** [docs/research/02-hardware-capabilities.md](docs/research/02-hardware-capabilities.md)
   so you know what to expect from each radio.
2. **Set up the Pi** — [docs/ops/01-pi-setup.md](docs/ops/01-pi-setup.md)
3. **Set up the Wi-Fi adapter** — [docs/ops/02-wifi-adapter.md](docs/ops/02-wifi-adapter.md)
   (there are real MT7921AU landmines here; read before plugging in)
4. **Verify with your DJI** — [docs/planning/test-plan.md](docs/planning/test-plan.md)

The first thing worth doing is capturing a PCAP of your DJI powering up. Everything else
is built against that ground truth.

```bash
python -m sensor_wifi.cli capture --iface wlan1 --channel 6 --out captures/dji-first-flight.pcap
```

---

## Project status

Greenfield. Milestone 0 (hardware bring-up) is the current work.
See [docs/planning/roadmap.md](docs/planning/roadmap.md).

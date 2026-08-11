# ClassG

[![CI](https://github.com/lnorton89/classg/actions/workflows/ci.yml/badge.svg)](https://github.com/lnorton89/classg/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust&logoColor=white)
![Node](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)

**Passive, multi-sensor drone detection for a Raspberry Pi.**

Named for [Class G airspace](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap3_section_1.html) —
the uncontrolled airspace below ~1200 ft AGL where nearly all drone activity happens and
where almost nobody is watching.

**ClassG is receive-only.** It never transmits, never jams, never spoofs, never takes over a
drone. See [docs/research/06-legal-and-ethics.md](docs/research/06-legal-and-ethics.md) — this
is a design constraint, not a disclaimer.

## Contents

- [What this actually detects](#what-this-actually-detects)
- [Architecture in one picture](#architecture-in-one-picture)
- [Optional integrations](#optional-integrations)
- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Project status](#project-status)
- [Contributing](#contributing)
- [Acknowledgments](#acknowledgments)
- [License](#license)

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
| D | ADS-B manned traffic (correlation + false-positive suppression) | SDR / network | Milestone 2 |
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

One JSON Schema contract in [`schemas/`](schemas/) is normative across all four; every service
validates against it, so a wire mismatch fails loudly instead of silently.

---

## Optional integrations

Five free data sources plug in around the core pipeline. All **off by default**, all
**inbound only**, all degrading to exactly the behaviour that exists without them — a missing
file or a dropped uplink costs enrichment, never detection.

| Source | Adds | Needs a live uplink? |
|---|---|---|
| [adsb.lol](https://api.adsb.lol/docs) | Manned traffic for Class D, with no SDR fitted | Yes |
| [OpenTopoData](https://www.opentopodata.org/) | Real `height_agl_m` from geodetic altitude minus terrain | No, if self-hosted |
| [OpenSky aircraft database](https://opensky-network.org/datasets/metadata/) | Registration and type for ADS-B contacts | No |
| [IEEE MA-L registry](https://standards-oui.ieee.org/) | Every OUI a drone vendor actually holds | No |
| [Protomaps](https://protomaps.com) / [OpenFreeMap](https://openfreemap.org) | A vector basemap that works with the uplink unplugged | No, with Protomaps |

Details, env vars, and the two rules that shaped all of them:
[docs/ops/07-external-data.md](docs/ops/07-external-data.md).

---

## Getting started

### Prerequisites

- A Raspberry Pi for a real deployment, or any Linux/WSL box for development
- [ALFA AWUS036AXML](docs/ops/02-wifi-adapter.md) and/or an [RTL-SDR V4](docs/ops/03-sdr-setup.md) — see [hardware capabilities](docs/research/02-hardware-capabilities.md) for what each one actually buys you
- Go 1.26+, Python 3.11+, Rust (stable, 2021 edition), Node 22+ — only needed for the services you're touching; Docker for the web tier

### Configure

Configuration is centralized in `.env`; bootstrap it from the committed contract before
running anything. See [docs/ops/00-configuration.md](docs/ops/00-configuration.md).

```bash
make env
```

### Read before you plug anything in

1. **Read** [docs/research/02-hardware-capabilities.md](docs/research/02-hardware-capabilities.md)
   so you know what to expect from each radio.
2. **Set up the Pi** — [docs/ops/01-pi-setup.md](docs/ops/01-pi-setup.md)
3. **Set up the Wi-Fi adapter** — [docs/ops/02-wifi-adapter.md](docs/ops/02-wifi-adapter.md)
   (there are real MT7921AU landmines here; read before plugging in)
4. **Verify with your DJI** — [docs/planning/test-plan.md](docs/planning/test-plan.md)

### Run it

The first thing worth doing is capturing a PCAP of your DJI powering up. Everything else
is built against that ground truth.

```bash
cd services/sensor-wifi
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[replay]'
.venv/bin/python -m classg_wifi.cli capture \
  --iface wlan1 --channel 6 --out ../../captures/dji-first-flight.pcap
```

The operator UI also runs without hardware, using deterministic mock scenarios:

```bash
cd services/ui
npm ci
npm run dev
```

To run the real web stack through Windows Docker while the adapter remains in
WSL, see [docker/README.md](docker/README.md):

```bash
make compose-up
cd services/sensor-wifi
.venv/bin/python -m classg_wifi.cli replay \
  ../../captures/20260810-141223-dji-first-flight.pcap
```

### Run the tests

```bash
make test    # all five suites: wifi, fusion, api, ui, sdr
make lint    # mirrors the lint jobs in CI — see CLAUDE.md for what it doesn't cover
```

---

## Repository layout

```
classg/
├── docs/
│   ├── research/       Band plans, protocol formats, prior art, legal
│   ├── architecture/   System design, data model, ADRs
│   ├── planning/       Roadmap, milestones, test plan
│   └── ops/            Pi setup, adapter setup, calibration, troubleshooting
├── schemas/            JSON Schema — the cross-language contract
├── services/
│   ├── sensor-wifi/    Python: monitor mode, channel hopping, frame parsing
│   ├── sensor-sdr/     Rust: IQ streaming, FFT, energy detection
│   ├── sensor-ble/     Python: BlueZ / Sniffle BLE Remote ID (Milestone 4, not yet implemented)
│   ├── fusion/         Go: detection→track correlation, scoring
│   ├── api/            Go: REST + WebSocket
│   └── ui/             Vite + MapLibre
├── config/             Seed defaults for Tier 2 settings
├── captures/           PCAP / IQ corpus (gitignored, see captures/README.md)
├── scripts/            Bring-up, data-fetch, and diagnostic helpers
└── docker/             Compose for the web tier; see docs/ops for USB caveats
```

---

## Documentation

[docs/README.md](docs/README.md) is the full documentation index. If you read three things
beyond this README, make them:

1. **[Hardware capabilities](docs/research/02-hardware-capabilities.md)** — what each radio
   can and cannot do. Prevents the most expensive mistakes in the project.
2. **[Architecture overview](docs/architecture/overview.md)** — how it all fits together.
3. **[Roadmap](docs/planning/roadmap.md)** — what's built, what's next, and the exit criteria
   for each milestone.

---

## Project status

Milestone 0 hardware bring-up remains the current validation work. The Milestone 1 software
foundation is implemented, but it is not considered complete until it passes the real-flight
exit criterion against the capture corpus.
See [docs/planning/roadmap.md](docs/planning/roadmap.md).

---

## Contributing

Issues and pull requests are welcome. Before sending a change:

- Run the checks for whatever you touched (`make lint`, plus the relevant suite from
  `make test`) and mention what you ran — a green result nobody reproduced isn't evidence.
- Match the existing style: this codebase comments the *why*, not the *what*, and several
  comments record measurements taken against real hardware. If you change behaviour a comment
  describes, re-measure or update it rather than leaving a confident statement that's gone stale.
- Changing `schemas/` means updating Python, Rust, Go, and TypeScript together — it's the one
  contract all four services share.
- Keep the receive-only constraint intact. No code path may transmit, jam, spoof, or take over
  a drone; see [docs/research/06-legal-and-ethics.md](docs/research/06-legal-and-ethics.md) for
  why that's non-negotiable.

---

## Acknowledgments

Built on [ASTM F3411](docs/research/03-protocol-remote-id.md) / the
[OpenDroneID](https://github.com/opendroneid) reference decoders, [MapLibre GL](https://maplibre.org/)
and [Protomaps](https://protomaps.com) for offline-capable mapping, [ZeroMQ](https://zeromq.org/)
for the sensor bus, and [libSQL](https://turso.tech/libsql) for local-first storage with optional
sync. Prior art and what was borrowed from where: [docs/research/05-prior-art.md](docs/research/05-prior-art.md).

---

## License

MIT — see [LICENSE](LICENSE).

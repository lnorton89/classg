# Documentation index

## Start here

If you read three documents, read these:

1. **[Hardware capabilities](research/02-hardware-capabilities.md)** — what each radio can and
   cannot do. Prevents the most expensive mistakes in the project.
2. **[Architecture overview](architecture/overview.md)** — how it fits together.
3. **[Roadmap](planning/roadmap.md)** — what to build, in order.

## Research

| Doc | Contents |
|---|---|
| [01 — RF landscape](research/01-rf-landscape.md) | What a drone emits, band by band; detection physics |
| [02 — Hardware capabilities](research/02-hardware-capabilities.md) | RTL-SDR V4 and AWUS036AXML analysed honestly; the capability matrix |
| [03 — Remote ID protocol](research/03-protocol-remote-id.md) | ASTM F3411 wire format |
| [04 — DJI protocol](research/04-protocol-dji.md) | Wi-Fi DroneID vs OcuSync DroneID |
| [05 — Prior art](research/05-prior-art.md) | What exists, what to borrow, what's genuinely open |
| [06 — Legal and ethics](research/06-legal-and-ethics.md) | Why receive-only, and what that constrains |

## Architecture

| Doc | Contents |
|---|---|
| [Overview](architecture/overview.md) | Components, channel strategy, track lifecycle, failure modes |
| [Data model](architecture/data-model.md) | Detection and Track types, confidence scoring, retention |
| [API contract v1](architecture/api-contract.md) | Normative interface for the api service, CLI, and web app |

### Decision records

| ADR | Decision |
|---|---|
| [0001](architecture/adr/0001-language-split.md) | Four languages, chosen by constraint |
| [0002](architecture/adr/0002-message-bus-zeromq.md) | ZeroMQ PUB/SUB as the sensor bus |
| [0003](architecture/adr/0003-sensor-process-isolation.md) | One process per radio |
| [0004](architecture/adr/0004-rtlsdr-scope.md) | The RTL-SDR does not detect DJI drones |
| [0005](architecture/adr/0005-own-sniffer-vs-kismet.md) | Own capture loop rather than wrapping Kismet |
| [0006](architecture/adr/0006-storage-turso-libsql.md) | libSQL (Turso) storage, local-first with optional sync |

## Planning

| Doc | Contents |
|---|---|
| [Roadmap](planning/roadmap.md) | Milestones 0–5 with exit criteria |
| [Test plan](planning/test-plan.md) | Five test layers, from unit tests to flight tests |

## Operations

| Doc | Contents |
|---|---|
| [01 — Pi setup](ops/01-pi-setup.md) | Hardware, OS, toolchains, tuning |
| [02 — Wi-Fi adapter](ops/02-wifi-adapter.md) | **Read before plugging it in** — two ways to break it |
| [03 — SDR setup](ops/03-sdr-setup.md) | The V4 needs a specific driver fork |
| [04 — Calibration](ops/04-calibration.md) | DJI field units — fill in during Milestone 1 |
| [05 — Troubleshooting](ops/05-troubleshooting.md) | Diagnose bottom-up, not top-down |

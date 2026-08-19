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
| [07 — Phones as sensors](research/07-phones-as-sensors.md) | Why a PWA cannot be a drone sensor, and what a phone can usefully contribute |

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
| [0007](architecture/adr/0007-configuration-tiers.md) | Bootstrap env / database settings / YAML seed |
| [0008](architecture/adr/0008-adsb-via-dump1090.md) | dump1090 owns the radio; fusion consumes its decoded output |
| [0009](architecture/adr/0009-networked-sensor-array.md) | Networked sensor array, and what it can honestly locate |

## Planning

| Doc | Contents |
|---|---|
| [Roadmap](planning/roadmap.md) | Milestones 0–5 with exit criteria |
| [Test plan](planning/test-plan.md) | Five test layers, from unit tests to flight tests |
| [Brand identity](planning/brand-identity.md) | The mark, the wordmark, the three colours, and where the source assets live |

## Operations

| Doc | Contents |
|---|---|
| [00 — Configuration](ops/00-configuration.md) | Env / database settings / YAML seed tiers, and how to bootstrap `.env` |
| [01 — Pi setup](ops/01-pi-setup.md) | Hardware, OS, toolchains, tuning |
| [02 — Wi-Fi adapter](ops/02-wifi-adapter.md) | **Read before plugging it in** — two ways to break it |
| [03 — SDR setup](ops/03-sdr-setup.md) | The V4 needs a specific driver fork |
| [04 — Calibration](ops/04-calibration.md) | DJI field units — fill in during Milestone 1 |
| [05 — Troubleshooting](ops/05-troubleshooting.md) | Diagnose bottom-up, not top-down |
| [06 — First capture](ops/06-first-capture.md) | Capture a DJI powering up and get a ground-truth PCAP |
| [07 — External data](ops/07-external-data.md) | Five optional feeds, all off by default, none of them gating detection |
| [08 — Cloud sessions](ops/08-cloud-tailscale.md) | Reach the Pi over Tailscale from Claude Code on the web |
| [09 — Deployment](ops/09-deployment.md) | Install, run, and update the stack on a real unit: Compose web tier, systemd sensors |
| [10 — Continuous deployment](ops/10-continuous-deployment.md) | Deploy `main` automatically when CI is green, and why it is pull-based and opt-in |
| [11 — Self-healing](ops/11-self-healing.md) | What survives a reboot, and the bounded watchdog that retries what systemd has given up on |
| [12 — Spectrum sweeps](ops/12-spectrum-sweeps.md) | The host agent that sweeps on the API's behalf, and the shared-group permission the exchange needs |
| [13 — Backup and restore](ops/13-backup-and-restore.md) | The database is the only irreplaceable artifact: Turso replication and how to verify it, cold copies, restore onto a fresh card, and uninstall |

## Development

Neither of these was linked from here, which is part of why the rules in them
kept being rediscovered the hard way.

| Doc | Contents |
|---|---|
| [Concurrent agents](dev/concurrent-agents.md) | Why `git add -A` is banned in this repo, and how to recover when it happens anyway |
| [Dependencies](dev/dependencies.md) | What is pinned, what is deliberately held back and why, and what actually counts as checking a dependency change |

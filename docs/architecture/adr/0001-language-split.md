# ADR-0001: Four languages, chosen by constraint

**Status:** Accepted · **Date:** 2026-08-10

## Context

Python, Go, Rust, and Node are all available. Using all four because they are available would
be self-indulgent; using one because it is simpler ignores that the components have genuinely
different constraints.

## Decision

| Component | Language | Binding constraint |
|---|---|---|
| `sensor-wifi` | Python 3.11+ | **Protocol churn.** DJI moves field offsets between firmware revisions; new vendor IEs appear. Iteration speed dominates. Beacon rate is ~1 Hz — throughput is irrelevant. Scapy/pcap ecosystem lives here. |
| `sensor-sdr` | Rust | **Sustained DSP.** 2.4 MSPS complex = 4.8M floats/sec, continuous, with FFTs, while retuning. Needs predictable latency and no GC pauses on a Pi. Clean error semantics when USB drops mid-read. |
| `fusion`, `api` | Go | **Concurrent stateful correlation.** Many tracks with independent expiry timers, plus WebSocket fan-out. Goroutines and channels map directly onto this. Single static binary is a real operational win on a Pi. |
| `ui` | Node / Vite + MapLibre | Only realistic option for an interactive map. MapLibre handles offline tiles. |
| `sensor-ble` | Python | Shares the ODID parser with `sensor-wifi`. Splitting the parser across two languages would be strictly worse. |

## Consequences

**Cost:** four toolchains, four dependency systems, cross-language contract maintenance.

**Mitigation:** the contract is JSON Schema in `schemas/`, validated in CI by all services.
Language boundaries align exactly with process boundaries, so there is no FFI anywhere and
no shared memory — only ZMQ messages.

**Explicitly rejected:** rewriting `sensor-wifi` in Go to reduce language count. The Wi-Fi
sensor is where the most experimentation will happen, and Python's iteration speed is worth
more than toolchain consolidation. Revisit only if the parser stabilises and profiling shows
Python as the bottleneck — neither is likely at 1 Hz.

**Escape hatch:** because every sensor is an isolated process speaking JSON over ZMQ, any
sensor can be rewritten in any language without touching another component.

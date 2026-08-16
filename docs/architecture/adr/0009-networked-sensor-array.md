# ADR-0009: Networked sensor array, and what it can honestly locate

**Status:** Proposed · **Date:** 2026-08-16

## Context

The goal is to run Wi-Fi adapters on several machines, feed them all into one fusion
process over the network, and use the extra vantage points to locate a drone rather
than merely notice it.

That goal is reachable. The word "triangulation" is where it goes wrong, so this ADR
starts with the physics, because the physics decides the architecture.

### What a commodity Wi-Fi adapter can actually measure

Per frame, in monitor mode, the radiotap header gives us two things worth anything for
localisation:

| Quantity | Available? | Field |
|---|---|---|
| Signal strength | yes | `rf.rssi_dbm` |
| Arrival time | yes, at host-clock resolution | `ts` |
| Angle of arrival | **no** — needs a phased array, not a dongle | — |
| Precise time of flight | **no** — see below | — |

### Why TDoA is not available at this budget

Time Difference of Arrival is the method that produces the tight hyperbolic fixes people
picture when they say triangulation. It converts clock error directly into position
error at the speed of light:

| Clock sync between nodes | Position error it implies |
|---|---|
| NTP over a LAN, ~1 ms | ~300 km |
| PTP software, ~100 µs | ~30 km |
| PTP hardware, ~1 µs | ~300 m |
| GPS PPS discipline, ~100 ns | ~30 m |

NTP is off by six orders of magnitude from useful. **TDoA needs a GPS receiver with a PPS
output at every node.** That is a hardware decision, not a software one, and it should be
made deliberately rather than discovered after writing a solver.

### What RSSI multilateration can do

RSSI is available today and needs no new hardware, but it estimates distance through a
path-loss model, and the model's assumptions are the error budget:

- multipath and reflections off buildings and terrain
- unknown and varying transmit power
- antenna orientation and polarisation at both ends
- non-line-of-sight attenuation

In open terrain with calibrated nodes this lands within roughly ±25-50% of true range.
Indoors or in clutter it degrades badly. That is a **coarse bearing-and-sector fix**, not
a coordinate.

This is still worth building. Knowing a drone is roughly 300 m north-east and closing is
operationally useful, and four sensors hearing the same emitter is itself strong evidence
it is real. But the number it produces must be presented with its error, or it becomes the
kind of false confidence [ADR-0003](0003-sensor-process-isolation.md) exists to prevent.

## Decision

Build the array in three stages, and **do not ship a position estimate more precise than
the method supports.**

### Stage 1 — Multi-sensor ingest and a sensor registry

Remote sensors are ordinary sensors that happen to be on another host. They publish the
existing detection schema; nothing about a sensor changes because it moved.

What is missing is that **fusion does not know where its sensors are.** `position` in
`detection.schema.json` is the *drone's* self-reported position from Remote ID — it is not
the observer's. A new registry maps sensor identity to a site:

```
sensor_id -> { lat, lon, alt_m, antenna_gain_dbi, antenna_pattern, clock_source }
```

This is configuration, not telemetry: it belongs in the ADR-0007 tiers alongside other
runtime settings, not on the wire with every frame.

### Stage 2 — Correlate, then estimate with an explicit error radius

Fusion groups detections of the same emitter (same MAC or Remote ID serial) seen by
different sensors within a short window, and emits a track carrying:

- how many sensors heard it, and which
- a weighted-centroid estimate biased toward the strongest receivers
- **an error radius**, not a point

A single-sensor track keeps whatever it has today and gains nothing false.

### Stage 3 — TDoA only behind GPS PPS

Do not implement a TDoA solver until nodes have PPS-disciplined clocks. Until then the
solver would be fitting noise, and it would look authoritative doing it.

## Consequences

**The schema contract changes, so four languages change together.** Per
[CLAUDE.md](../../../CLAUDE.md), `schemas/` is read by Python, Rust, Go and TypeScript.
Stage 2 adds observation provenance to `track.schema.json` — which sensors contributed,
and the estimate's error radius. Shipping that in one language is a silent wire mismatch.

**Clock quality becomes a first-class field, not an assumption.** Correlation windows
depend on it. A node whose clock is unsynchronised must still be usable, and must be
visibly marked as contributing to timing-independent results only. This is the same
principle as sensor health: degrade visibly.

**The bus leaves localhost, so it needs a trust boundary.** Today ZMQ carries detections
over loopback ([ADR-0002](0002-message-bus-zeromq.md)) and is unauthenticated, which is
fine when the only speaker is a process on the same machine. Across a LAN it is not:
anything on the network can inject fabricated detections into fusion. Options, cheapest
first — bind to a WireGuard or Tailscale interface, or enable ZMQ CURVE with a
pre-shared key. Picking one is a prerequisite for Stage 1, not a follow-up.

**Receive-only is unaffected.** Multilateration is entirely passive: more listeners, no
transmitters. Nothing here weakens the constraint in
[06-legal-and-ethics](../../research/06-legal-and-ethics.md).

**Cost of getting this wrong:** a map with a confident dot on it that is 400 m from the
drone. Operators trust maps. The error radius is not decoration.

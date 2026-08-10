# ADR-0002: ZeroMQ PUB/SUB as the sensor bus

**Status:** Accepted · **Date:** 2026-08-10

## Context

Sensors must publish detections to fusion, in four languages, on a single Pi, without a slow
consumer ever stalling a capture loop.

## Options considered

| Option | Verdict |
|---|---|
| **ZeroMQ PUB/SUB** | **Chosen.** Brokerless, first-class bindings in all four languages, non-blocking with configurable HWM, negligible overhead. Validated by WarDragon/DragonSync in exactly this role. |
| MQTT (Mosquitto) | Rejected: needs a broker process, an extra failure mode, and adds nothing at single-node scale. Reconsider if multi-node sensor deployment happens. |
| Unix domain sockets | Rejected: no pub/sub semantics, so fan-out becomes application code. |
| gRPC | Rejected: request/response is the wrong shape for a fire-and-forget telemetry stream. |
| Shared SQLite | Rejected: polling latency, and write contention on an SD card. |

## Decision

ZeroMQ PUB/SUB, JSON-encoded, over TCP on loopback.

```
Sensors  PUB  tcp://127.0.0.1:5556   topic: detection.<class>   e.g. detection.A
Fusion   PUB  tcp://127.0.0.1:5557   topic: track.<event>       e.g. track.update
```

**TCP on loopback rather than IPC sockets** — costs a little throughput, buys the ability to
move a sensor to a separate host with a config change. At these message rates the cost is
unmeasurable.

**JSON rather than msgpack/protobuf** — the bus carries a few messages per second. Human-
readable payloads are worth far more during bring-up than bytes saved. Revisit only if
message rate grows by orders of magnitude.

**Topic prefixes match `detection_class`** so a consumer can subscribe narrowly — e.g. a
future ADS-B-only display subscribes to `detection.D` and ignores everything else.

## Consequences

- **PUB/SUB drops messages when no subscriber is connected.** This is correct here: a
  detection with nobody listening is not worth queueing. Sensors must not assume delivery.
- **HWM must be set on every socket** (default: 1000). On overflow, sensors drop the oldest
  and increment `detections_dropped_total`. **A capture loop must never block on the bus** —
  losing a detection is recoverable, missing a beacon window is not.
- No delivery guarantee means no replay. Durability is `storage`'s job, downstream of fusion.

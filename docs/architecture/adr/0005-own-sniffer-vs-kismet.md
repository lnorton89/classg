# ADR-0005: Own capture loop rather than wrapping Kismet

**Status:** Accepted · **Date:** 2026-08-10

## Context

[Kismet](https://github.com/kismetwireless/kismet) already does monitor-mode capture, channel
hopping, and **DJI DroneID IE parsing** (`dot11_ie_221_dji_droneid`), and exposes a REST/WebSocket
feed. ClassG could consume that instead of writing a sniffer.

## Decision

Write our own capture loop in `sensor-wifi`, using Kismet's Kaitai definitions as a **format
reference** rather than as a runtime dependency.

## Rationale

**Channel dwell control is the crux of this project.** Remote ID beacons arrive at ~1 Hz, and
[overview.md](../overview.md#channel-strategy) identifies weighted, adaptive dwell as the
highest-leverage tuning problem — and the survey found no published work on it. Kismet's
hopping is designed for network discovery, not for maximising capture probability of a 1 Hz
beacon, and adapting it means fighting a large codebase's assumptions. Owning the loop makes
the experiment cheap.

Secondary reasons:

- **Adaptive escalation** (lock dwell to a channel on detection) needs tight feedback between
  the parser and the hopper. Across a REST boundary that loop is slow and awkward.
- **Fewer moving parts.** Kismet adds a large C++ dependency, its own config surface, and its
  own failure modes, to a Pi already running four services.
- **Raw frame access.** [data-model.md](../data-model.md) requires retaining source bytes so
  parser fixes can be applied retroactively — direct capture makes this trivial.

## Consequences

**We take on monitor-mode handling ourselves**, including mt7921u's documented quirks. Mitigated
by keeping that logic in one small module (`capture/monitor.py`) with the driver landmines
documented in [02-wifi-adapter.md](../../ops/02-wifi-adapter.md).

**We reimplement DJI IE parsing.** Acceptable — it is a few hundred lines, must be validated
against a real drone regardless, and firmware variation means we would need our own test
corpus even when wrapping Kismet.

## Fallback

If monitor-mode handling proves more painful than estimated during Milestone 0, running Kismet
as the capture layer and consuming its feed is a **legitimate retreat**, not a failure. The
`Detection` schema is the boundary — a Kismet-backed sensor emits the same messages, and
nothing downstream changes. Reassess at the end of Milestone 0 if the sniffer is not reliably
capturing beacons within a week.

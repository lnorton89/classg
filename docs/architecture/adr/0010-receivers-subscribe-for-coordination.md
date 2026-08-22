# ADR-0010: Sensors may subscribe, for coordination only

**Status:** Accepted · **Date:** 2026-08-21 · **Amends:** [ADR-0002](0002-message-bus-zeromq.md)

## Context

[ADR-0002](0002-message-bus-zeromq.md) made the sensor bus one-directional in
practice: sensors publish, fusion consumes. Nothing in that ADR forbids a sensor
subscribing, but nothing does it, and the assumption has hardened into a stated
property — `internal/httpapi/configapi.go` explains a `restart_required` flag
with "sensors subscribe to nothing, they only publish (ADR-0002)".

That assumption now costs coverage on a two-radio unit.

`config/channels-primary.yaml` and `config/channels-sweep.yaml` partition the
spectrum between the two Wi-Fi receivers. When either one detects a drone, the
hopper locks to that channel for `escalation_hold_s`, handing back one dwell in
`escalation_scan_every` to the sweep. On the companion receiver that means a
16-channel plan collapses to roughly one channel plus a 25% sample of the rest,
for 30 seconds at a time, renewed on every further detection — and the primary,
which has spare capacity and knows nothing about it, carries on sampling three
channels that the tracked aircraft demonstrably is not on.

Observed 2026-08-17 in the single-radio era: a drone held the ch6 lock for 2m45s
of continuous Class A hits and the radio visited nothing else for the whole
flight. `escalation_scan_every` was added for exactly that, and it bounds the
damage on one radio. It cannot make the *other* radio help.

## Options considered

| Option | Verdict |
|---|---|
| **Sensors SUB to fusion's existing track stream** | **Chosen.** Fusion already `Listen`s a PUB on `CLASSG_TRACK_ENDPOINT`, so the channel, the port and the direction all exist. Tracks carry `receivers[]` (ADR-0009 stage 2 provenance), which is already "which radio heard this, and when". No new message type, no schema change, no fusion change. |
| A new coordination message published by fusion | Rejected: a new wire type and a four-language schema change to carry information the track already carries. |
| Peer-to-peer between sensors | Rejected: every sensor needs every other sensor's endpoint, so configuration grows with the square of the fleet, and it re-solves fan-out that the broker-less bus already solved. |
| Widen `escalation_scan_every` on the sweep receiver instead | Rejected as the *whole* answer, but it is the honest fallback: it needs no coordination at all and recovers part of the loss. Kept available as a per-unit flag. It cannot use the idle capacity on the other radio, which is the point here. |
| The API coordinates over HTTP | Rejected: puts an HTTP client in a capture loop that must never block, to move data already on the bus. |

## Decision

**A sensor may open a SUB socket, for coordination only.** Concretely, one
narrow permission and one hard limit:

- It subscribes to fusion's track topic and reads `receivers[]` to learn whether
  a *peer* receiver has heard anything recently.
- The only thing it may change in response is **its own channel plan** — widening
  to its solo plan while a peer is busy tracking, narrowing back when the peer
  goes quiet.

**What a subscription must never do**, because these are what ADR-0002's
one-directional shape was protecting:

- **Never block the capture loop.** The SUB is polled non-blocking between
  dwells, exactly as the PUB side is non-blocking on send. A silent or absent
  fusion is the normal case, not an error, and leaves the split plan in force.
- **Never gate capture on receiving anything.** A sensor with no subscriber, no
  fusion, or no peers must behave precisely as it does today. Coordination is an
  optimisation on top of a working detector, never a dependency of one.
- **Never take configuration this way.** Channel plans, weights and calibration
  stay in the ADR-0007 tiers and are read at startup. Accepting settings over
  the bus would make the running configuration unobservable, which is the
  problem ADR-0007 exists to prevent.
- **Never transmit.** Unchanged and not negotiable — this is a SUB socket on
  loopback, not a radio (see
  [06-legal-and-ethics](../../research/06-legal-and-ethics.md)).

## Consequences

- **The "sensors only publish" shorthand is now wrong** and the comments that
  state it need correcting. The accurate statement is narrower: sensors take no
  *configuration* from the bus, so a channel-plan change still requires a
  restart.
- **PUB/SUB drops what nobody is listening for, in both directions now.** A
  sensor that starts before fusion misses coordination messages until fusion
  binds. Correct, and the reason the default state is the split plan: the
  configured behaviour is what you get when coordination is silent.
- **Fusion becomes a soft dependency of tuning, not of detection.** If fusion
  dies, both receivers keep their split plans and keep detecting. Coverage is
  then what it is today, which is the state this ADR improves on rather than
  the state it relies on.
- **Two sensors can widen at once**, when both have recent contact. That is
  duplicated coverage rather than a hole, so it fails in the safe direction.
- **This is not multilateration.** Reading a peer's `receivers[]` entry says
  *that* a peer heard something, never *where* it is. The position half of
  [ADR-0009](0009-networked-sensor-array.md) still needs its sensor-site
  registry and is untouched here.

## Not yet measured

The size of the win is unmeasured. The reasoning is sound and the failure
direction is safe, but nobody has yet flown an aircraft past a two-radio unit
and counted discoveries with coordination on and off. Until someone does, the
behaviour ships behind `--peer-coordination` and the honest claim is "this
should recover discovery during a track", not a figure.

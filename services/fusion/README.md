# fusion

`fusion` is the Go correlation library between sensor observations and the API.
It accepts immutable `Detection` payloads, associates them with a track by
identity, records evidence and position history, and advances each track
through `TENTATIVE`, `CONFIRMED`, `COASTING`, and `CLOSED`.

The library owns the deterministic correlation rules; the runtime wrapper is
`cmd/classg-fusion`, which subscribes to the detection bus, republishes tracks
and relays heartbeats, configured entirely from the environment
([ADR-0007](../../docs/architecture/adr/0007-configuration-tiers.md) — fusion
reads env, not the settings database). In deployment it runs as the
`classg-fusion` container and listens on the published bus port so host
sensors can dial in; see [docker/README.md](../../docker/README.md).

## Development

```bash
cd services/fusion
go test -race -count=1 ./...
```

## Contract and behavior

- Input fields mirror [`../../schemas/detection.schema.json`](../../schemas/detection.schema.json).
- A `(0, 0)` position is defensively discarded because it represents an absent
  GPS fix, not a position.
- Confidence is a transparent noisy-OR combination of evidence weights.
  ADS-B and GNSS-interference classes have zero confidence weight: they provide
  context rather than proof of a drone.
- Tracks coast for 30 seconds and close after five minutes; retained position
  history is capped at 512 samples.

Read [the data model](../../docs/architecture/data-model.md) before changing
weights, matching, or lifecycle thresholds. Those choices affect every client.

# fusion

`fusion` is the Go correlation library between sensor observations and the API.
It accepts immutable `Detection` payloads, associates them with a track by
identity, records evidence and position history, and advances each track
through `TENTATIVE`, `CONFIRMED`, `COASTING`, and `CLOSED`.

It intentionally has no `main` package. The API owns the runtime integration;
this package owns the deterministic correlation rules.

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

# Schemas

These JSON Schema Draft 2020-12 documents are the cross-language wire contract
for ClassG. Sensor implementations emit a `Detection`; fusion turns one or
more detections into a `Track`; the API and UI consume the resulting track
payloads.

| File | Defines |
|---|---|
| [`detection.schema.json`](detection.schema.json) | One immutable observation from one sensor |
| [`track.schema.json`](track.schema.json) | Fusion's stateful correlation of observations |

Both schemas currently require `schema_version: "1.0"`. Treat a schema edit as
an interface change: update every producer and consumer, add or revise tests,
and keep [`../docs/architecture/data-model.md`](../docs/architecture/data-model.md)
aligned. Operator locations and raw source bytes are sensitive fields; clients
must tolerate their absence.

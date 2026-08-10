# api (Go) — Milestone 1

REST + WebSocket front end for `fusion`. Not yet implemented.

## Planned surface

| Endpoint | Purpose |
|---|---|
| `GET /api/tracks` | Active tracks |
| `GET /api/tracks/{id}` | One track with history |
| `GET /api/detections?since=` | Recent detections (debugging) |
| `GET /api/health` | Per-sensor health |
| `WS /ws` | Live track updates |

## Two requirements that are not negotiable

**1. Health must distinguish "no drones" from "sensor broken."**

```jsonc
{
  "status": "degraded",
  "sensors": {
    "wifi-0": {"healthy": true,  "last_heartbeat": "...", "detections_5m": 0},
    "sdr-0":  {"healthy": false, "last_heartbeat": "...", "reason": "device not found"}
  }
}
```

A drone detector that silently stops detecting manufactures false confidence, which is worse
than being visibly offline. `detections_5m: 0` with `healthy: true` means a quiet sky;
`healthy: false` means don't trust the quiet.
See [ADR-0003](../../docs/architecture/adr/0003-sensor-process-isolation.md).

**2. Operator location is omitted by default.**

Strip `operator` from every response unless `CLASSG_EXPOSE_OPERATOR_LOCATION=true`. It is a
live map of where pilots are physically standing.
See [legal-and-ethics.md](../../docs/research/06-legal-and-ethics.md#operator-location-is-the-sharp-edge).

Storage lives here too: SQLite with WAL, separate retention for operator location so it can be
purged independently of everything else.

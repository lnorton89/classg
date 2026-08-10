# api (Go) — Milestone 1

REST + WebSocket front end for `fusion`, with local libSQL persistence and the
built Vite application served as a single-page app.

## Surface

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/tracks` | Active tracks |
| `GET /api/v1/tracks/{id}` | One track with history |
| `GET /api/v1/detections?since=` | Recent detections (debugging) |
| `GET /api/v1/health` | Per-sensor and fusion health |
| `WS /api/v1/stream` | Live track, detection, capture, and health updates |

## Run locally

```bash
cd services/ui && npm ci && npm run build
cd ../api && go run ./cmd/classg-api
```

The API automatically loads the nearest repository `.env`; an explicit process
environment value wins. Set `CLASSG_ENV_FILE` to require a particular file.

The default database is `services/api/classg.db`; set `CLASSG_STORE=memory` for
an ephemeral development run. The API stays available when sensors or fusion
are offline and reports that state through `/api/v1/health`.

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

**2. Operator-location exposure is controlled in one place.**

Set `CLASSG_EXPOSE_OPERATOR_LOCATION=false` to strip `operator` from every response. It is a
live map of where pilots are physically standing, so deployments must make this choice
deliberately.
See [legal-and-ethics.md](../../docs/research/06-legal-and-ethics.md#operator-location-is-the-sharp-edge).

Storage lives here too: embedded libSQL locally, with optional Turso sync.

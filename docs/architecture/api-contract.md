# API contract v1

**This document is normative.** The Go `api` service, the `classgctl` CLI, and the web app are
all built against it. It exists so those three can be developed independently without
inventing incompatible interfaces.

Base URL: `http://<host>:8081/api/v1`

## Principles

1. **The web app and the CLI are peers.** Both are pure clients of this API. Neither depends
   on the other, and anything one can do, the other can do.
2. **The API is the only writer.** Clients never touch the ZMQ bus, the database, or config
   files directly.
3. **Operator location is opt-in.** See [privacy](#privacy-non-negotiable).
4. **Nothing here transmits RF.** Control endpoints start and stop *receive-only* processes.

---

## Health

### `GET /health`

The most important endpoint in the system. It must distinguish **"no drones are flying"** from
**"a sensor is broken"** — a detector that fails silently manufactures false confidence.

```jsonc
{
  "status": "ok",                    // ok | degraded | down
  "uptime_s": 8412,
  "version": "0.1.0",
  "sensors": [
    {
      "sensor_id": "wifi-0",
      "sensor_kind": "wifi",
      "healthy": true,
      "last_heartbeat": "2026-08-10T14:31:02Z",
      "seconds_since_heartbeat": 3,
      "detections_5m": 0,            // 0 + healthy:true  => quiet sky
      "detail": { "channel": 6, "listening_fraction": 0.71 }
    },
    {
      "sensor_id": "sdr-0",
      "sensor_kind": "sdr",
      "healthy": false,              // => do NOT trust the quiet
      "last_heartbeat": "2026-08-10T14:12:44Z",
      "seconds_since_heartbeat": 1098,
      "reason": "device not found"
    }
  ]
}
```

`status` is `degraded` when any sensor is unhealthy but at least one is healthy; `down` when
none are healthy.

**UI requirement:** an empty map with an unhealthy sensor must look visibly different from an
empty map with all sensors healthy. This is the single most important thing the interface
communicates.

---

## Tracks

### `GET /tracks`

| Param | Type | Default | Notes |
|---|---|---|---|
| `state` | csv | all | e.g. `CONFIRMED,COASTING` |
| `since` | RFC3339 | — | `last_seen >= since` |
| `min_confidence` | float | 0 | |
| `limit` | int | 100 | max 1000 |
| `cursor` | string | — | opaque; from `next_cursor` |

```jsonc
{ "tracks": [ /* track.schema.json */ ], "next_cursor": null, "total": 3 }
```

### `GET /tracks/{track_id}`
Full track including `history`. `404` if unknown.

### `GET /tracks/{track_id}/detections`
Detections that fed this track, newest first. Same paging params.

---

## Detections

### `GET /detections`

| Param | Notes |
|---|---|
| `class` | csv of `A`–`H` |
| `sensor_id` | filter to one sensor |
| `since`, `limit`, `cursor` | as above |

Returns `detection.schema.json` objects. Primarily a debugging view — the UI should default to
tracks, not raw detections.

---

## Live stream

### `WS /stream`

Subscribe on connect:

```jsonc
{ "type": "subscribe", "topics": ["tracks", "health", "detections"] }
```

Server frames — every frame has `type` and `ts`:

```jsonc
{ "type": "track.update",  "ts": "...", "track": { /* Track */ } }
{ "type": "track.closed",  "ts": "...", "track_id": "..." }
{ "type": "detection",     "ts": "...", "detection": { /* Detection */ } }
{ "type": "health",        "ts": "...", "health": { /* as GET /health */ } }
{ "type": "capture.status","ts": "...", "capture": { /* as GET /captures/{id} */ } }
```

Requirements:
- Server sends `{"type":"ping"}` every 30 s; clients reply `{"type":"pong"}`.
- Clients reconnect with exponential backoff and **refetch `GET /tracks` on reconnect** — the
  stream carries no history and gaps must not silently persist.
- Server drops slow consumers rather than buffering without bound.

---

## Captures

Milestone 0 is capture-driven, so this is first-class rather than an afterthought.

### `GET /captures`
```jsonc
{ "captures": [ {
  "capture_id": "01J8...", "filename": "2026-08-10-first-flight.pcap",
  "state": "completed",            // running | completed | failed
  "started_at": "...", "ended_at": "...",
  "iface": "wlan1", "channel": 6, "duration_s": 120,
  "size_bytes": 481233, "frame_count": 1841,
  "analysis": { "analyzed": true, "drone_transmitters": 1, "class_a": 118, "class_b": 0 }
} ] }
```

### `POST /captures`
```jsonc
{ "iface": "wlan1", "channel": 6, "duration_s": 120, "label": "first-flight" }
```
`202 Accepted` with the capture object. Runs the same path as `scripts/first-capture.sh`.

Requires elevated privileges; if unavailable return `503` with
`{"error":{"code":"privileges_required","message":"..."}}` rather than failing obscurely.

### `POST /captures/{id}/stop` · `POST /captures/{id}/analyze`
`analyze` runs the `classg_wifi.cli analyze` pipeline and returns the structured report:
channel usage, measured beacon interval, decoded identities, and the DJI calibration table.

### `GET /captures/{id}/report`
The analysis as structured JSON (not the rendered text).

### `GET /captures/{id}/download`
Streams the raw `.pcap` — `Content-Type: application/vnd.tcpdump.pcap`, with a
`Content-Disposition` filename. Streamed, never buffered whole, since captures get large.

Opening a capture in Wireshark is the natural next step after a field capture, which is why
this exists. Note that a capture contains every network in range, not only drones.

---

## Sensors

### `GET /sensors` — as the `sensors` array in `/health`, with full config.
### `POST /sensors/{id}/restart` — `202`. Restart-only; there is no "start transmitting".

---

## Config

### `GET|PUT /config/channels` — the weighted channel plan.
### `GET|PUT /config/weights` — fusion confidence weights.

`PUT` validates and returns `400` with per-field errors on failure. Changes take effect
without a restart where possible; the response includes `"restart_required": bool`.

---

## Errors

Uniform envelope, always:

```jsonc
{ "error": { "code": "invalid_parameter", "message": "limit must be <= 1000", "field": "limit" } }
```

Codes: `invalid_parameter`, `not_found`, `conflict`, `privileges_required`,
`sensor_unavailable`, `internal`.

---

## Data handling

- `operator` (the pilot's ground position) is **included by default**.
  `CLASSG_EXPOSE_OPERATOR_LOCATION=false` turns it off. Clients must still render correctly
  when it is absent — a drone that broadcasts no System message has no operator position — and
  must not treat absence as an error.
- The UI marks it distinctly from an aircraft, for the plain reason that a person standing on
  the ground is not an aircraft.
- **There is no threat scoring anywhere in this API.** `confidence` answers *"is this really a
  drone"*. Clients must not relabel it as threat, priority, or risk — that is a policy
  judgment belonging to whoever operates the system, not something to bake into the data model.

## Constraints that are legal, not preferences

These hold regardless of deployment choices, and are not configurable:

- **Receive-only.** No endpoint causes RF transmission. No injection, deauth, or jamming
  (47 U.S.C. §333, §302a).
- **No payload demodulation.** Class E/F expose envelope and cadence only — never control-link
  packet contents or FPV video. That is the Wiretap Act line.

## Auth

**None in v1.** Bind to localhost or a trusted LAN. Documented explicitly so nobody assumes
otherwise: do not expose this to the internet.

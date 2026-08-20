# API contract v1

**This document is normative.** The Go `api` service and the web app are both built against
it, and anything else that talks to the API — `curl`, scripts, a future CLI — holds it to
the same contract. It exists so clients and server can be developed independently without
inventing incompatible interfaces. (There is no `classgctl` binary today; earlier drafts
named one, and this document is written so that building it needs no API changes.)

Base URL: `http://<host>:8081/api/v1`

## Principles

1. **Every client is a peer.** The web app is a pure client of this API, and so is any
   script or CLI. Nothing depends on another client, and anything one can do, another can.
2. **The API is the only writer.** Clients never touch the ZMQ bus, the database, or config
   files directly.
3. **Operator location exposure is controlled in one place** — included by default for this
   deployment, removable everywhere with one flag. See [data handling](#data-handling).
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
    },
    {
      "sensor_id": "ble-0",
      "sensor_kind": "ble",
      "healthy": false,
      "optional": true,              // declared as hardware this unit may lack
      "last_heartbeat": null,
      "seconds_since_heartbeat": null,
      "reason": "not fitted"         // never reported => excluded from status
    }
  ]
}
```

`status` is `degraded` when any sensor is unhealthy but at least one is healthy; `down` when
none are healthy.

A sensor declared `optional` that has **never** reported is listed but excluded from that
tally, so a unit built without an SDR or BLE dongle reads `ok` rather than sitting at
`degraded` forever — a standing warning trains operators to ignore warnings, which is the
same false confidence this endpoint exists to prevent, reached from the other direction.
The exclusion covers only the never-reported case: once an optional sensor has heartbeated
it counts like any other, so one that worked and then went quiet still degrades `status`.

**UI requirement:** an empty map with an unhealthy sensor must look visibly different from an
empty map with all sensors healthy. This is the single most important thing the interface
communicates.

### `GET /metrics`

Prometheus exposition of the same `Report` `/health` returns, so the two can never disagree
about whether a sensor is alive. Deliberately **not** under `/api/v1`: scrapers default to
`/metrics`, and the error envelope means nothing to one.

```
classg_status{status="ok"} 1
classg_uptime_seconds 35727
classg_sensor_healthy{sensor_id="wifi-0",sensor_kind="wifi"} 1
classg_sensor_heartbeat_age_seconds{sensor_id="wifi-0",sensor_kind="wifi"} 2
classg_wifi_listening_fraction{sensor_id="wifi-0"} 0.9312
classg_sdr_dump1090_connected{sensor_id="sdr-0"} 1
```

`classg_wifi_listening_fraction` is the roadmap's hopper efficiency: the share of wall clock
spent receiving rather than retuning.

`classg_sensor_heartbeat_age_seconds` is **absent**, not zero, for a sensor that has never
reported — zero would read as "heard from just now", which is the inversion `/health` exists
to prevent.

Sensor `detail` is exported through an **allowlist**, never wholesale. `detail` is whatever a
sensor chose to publish, and `/metrics` is the endpoint most likely to be scraped into somebody
else's database. Operator positions are pilot ground positions and personal data under GDPR
([legal and ethics](../research/06-legal-and-ethics.md)); [ADR-0006](adr/0006-storage-turso-libsql.md)
records that this deployment accepts syncing them, which is a decision about this unit and not a
reason to export whatever a sensor happens to publish. A key that is not named in
`sensorDetailMetrics` is not exported, and a test enforces it.

### `GET /system`

Backs the UI's **About** panel: what this binary is, how it is configured, and how the Pi
underneath is doing. Separate from `/health` because `/health` is polled hard and answers one
question; a `statfs` and a pile of build strings do not belong on that path.

```jsonc
{
  "build":   { "version": "0.1.0", "go_version": "go1.26.0", "revision": "…" },
  "runtime": { "listen": ":8081", "store": "libsql", "ui_dir": "off",
               "capture_dir": "/captures", "turso_sync_configured": false,
               "containerised": true },
  "host": {
    "uptime_s": 11779, "load1": 0.69, "load5": 1.32, "load15": 1.06,
    "cpu_count": 4, "cpu_temp_c": 42.842,
    "mem_total_kb": 3887868, "mem_available_kb": 3408376,
    "disk_path": "/data", "disk_total_bytes": 125000000000, "disk_free_bytes": 93000000000,
    "unavailable": {
      "throttled": "vcgencmd is not available to the api; run `vcgencmd get_throttled` on the Pi"
    }
  }
}
```

**Every host figure is nullable, and null carries a reason.** A value the api could not read is
`null` with an entry in `host.unavailable` explaining why — never a zero. `0` °C and an uptime of
`0` s both render as plausible readings and are both lies, which is the same inversion `/health`
exists to prevent. A UI must render `null` as "unavailable", not as a dash that looks like data.

`throttled` is **always** in `unavailable`. Undervoltage and thermal throttling live behind
`vcgencmd`, which needs the binary and `/dev/vcio`; the api image has neither and this kernel
exposes no sysfs equivalent. It is listed explicitly so a missing throttle flag can never be read
as "not throttled".

`runtime` is an **allowlist**. An About panel that lists configuration is a well-worn way to
publish a credential, so Turso is reported as `turso_sync_configured: true|false` — never the URL
and never the token. `revision` is absent in container builds because `.dockerignore` excludes
`.git`, so the toolchain has no VCS to stamp.

### `GET /telemetry`

Recorded host and sensor history — the same readings `/system` reports live, written down
once a minute so there is something to look back at. `/metrics` exposes the current numbers and
nothing on a field unit scrapes them, so without this there is no history at all.

| Parameter | Default | Notes |
|---|---|---|
| `window` | `6h` | Go duration, max `720h` |
| `since` | — | RFC3339; overrides `window` |

```jsonc
{
  "samples": [
    { "ts": "2026-08-17T20:00:00Z", "cpu_temp_c": 46.25, "load1": 0.69,
      "mem_available_kb": 3409708, "disk_free_bytes": 92687323136, "uptime_s": 12167,
      "sensors": [ { "sensor_id": "wifi-0", "sensor_kind": "wifi", "healthy": true,
                     "metrics": { "beacons": 15886, "listening_fraction": 0.74 } } ] }
  ],
  "since": "2026-08-17T14:00:00Z", "until": "2026-08-17T20:00:00Z", "truncated": false
}
```

Samples are ascending by time, because every consumer is a chart and a chart reads left to
right. `truncated` is true when the window held more samples than the 5000-sample cap returned;
a chart whose axis claims 24 h while showing 6 h of data is a lie, so it is reported rather
than left to be inferred.

**Every host figure is nullable, and `null` means the api could not read it.** A client must
draw a **gap**, never a point at zero and never a line interpolated across the hole — `0` °C is
a plausible temperature and `0` bytes free is a plausible disk. This is the same rule
`/system` follows, carried through storage and the wire.

`sensors[].metrics` carries only the keys named in `internal/sensormetrics`, the single
allowlist shared with `/metrics`. It governs what is written to disk and kept for a fortnight,
not just what is exposed, so adding a key there is the deliberate act of recording it.

Sampling records raw readings and computes nothing — no rates, no smoothing. A stored average
cannot be un-averaged later, and a raw sample can always be reduced by whoever draws the chart.

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

### `GET /tracks/{track_id}/export`

One track's flight path as a downloadable file, so it can be opened in Google Earth, QGIS or a
spreadsheet rather than only in this UI. Responds with `Content-Disposition: attachment` and a
filename of `classg-<track_id>.<ext>`.

| `format` | Content-Type | Contents |
|---|---|---|
| `geojson` *(default)* | `application/geo+json` | `FeatureCollection`: a `LineString` of the flight path with track metadata in `properties` |
| `csv` | `text/csv` | One row per position — `track_id, at, lat, lon, alt_geodetic_m, height_agl_m, speed_mps, track_deg` |
| `kml` | `application/vnd.google-earth.kml+xml` | A `Placemark` `LineString` at `altitudeMode: absolute` |

**Operator location obeys `CLASSG_EXPOSE_OPERATOR_LOCATION` in every format.** An export is a
file that leaves the unit, so redaction is applied once before any formatter runs rather than
per format — a gate applied per formatter is a gate somebody forgets on the fourth one.

GeoJSON coordinates are `[lon, lat, alt]`, the reverse of how the rest of this contract writes a
position. Getting it backwards is the standard way to produce an export that plots in the sea.

Absent measurements are **empty** in CSV, never `0` — a spreadsheet averaging a column of
altitudes must not be handed sea level for the fixes that never carried one. A track with no
positions still exports its metadata, because an empty file reads as a failed export.

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
{ "type": "subscribe", "topics": ["tracks", "health", "detections", "captures", "spectrum"] }
```

**Subscribe to everything you handle.** The server filters by topic and drops
what you did not ask for, silently — which is not a hypothetical: the web app
handled `capture.status` for months while never subscribing to `captures`, so
that handler was dead code and a running capture only advanced when some query
happened to refetch.

Server frames — every frame has `type` and `ts`:

```jsonc
{ "type": "track.update",  "ts": "...", "track": { /* Track */ } }
{ "type": "track.closed",  "ts": "...", "track_id": "..." }
{ "type": "detection",     "ts": "...", "detection": { /* Detection */ } }
{ "type": "health",        "ts": "...", "health": { /* as GET /health */ } }
{ "type": "monitoring",    "ts": "...", "monitoring": { /* as GET /monitoring */ } }
{ "type": "capture.status","ts": "...", "capture": { /* as GET /captures/{id} */ } }
{ "type": "sweep.status",  "ts": "...", "sweep": { /* the RECORD, never its bins */ } }
```

`monitoring` rides the `health` topic rather than needing its own: whether the
system is recording is part of whether it is working, and a client that cares
about one always cares about the other.

`sweep.status` carries the sweep **record** and never its measurement. A
completed wideband sweep is over a megabyte of bins, and pushing that down
every open socket to announce "it finished" would cost more than the sweep did
— fetch `GET /spectrum/sweeps/{id}` for the trace. It is published *after* the
bins are stored, so a client that refetches immediately cannot win a race
against the write and cache an empty answer.

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

## Spectrum

Band sweeps from the SDR sensor. **Energy measurement only.** A peak above
threshold means something is transmitting; it never means a drone. The detector
that could tell an ELRS burst train from a smart meter is Milestone 3, it needs
a test transmitter to validate against, and until it exists no field here may
imply a classification.

Sweeps are operator-initiated rather than continuous, and that is forced by
[ADR-0008](adr/0008-adsb-via-dump1090.md): `dump1090` owns the dongle on a
working unit, so a live waterfall would mean permanent ADS-B blindness. A sweep
borrows the radio for one band and gives it back. The cost is real, it is tens
of seconds of no ADS-B, and it belongs to whoever pressed the button.

### `GET /spectrum/bands`
```jsonc
{ "bands": [ {
  "name": "ism_915", "class": "E", "start_hz": 902000000, "stop_hz": 928000000,
  "steps": 14, "note": "ELRS 900, TBS Crossfire, RFD900. Heavy clutter: ..."
} ],
  "available": true,          // false on a unit with no SDR, or a sensor built
  "reason": "",               //   without the `rtlsdr` feature -- reason says which
  "running_sweep_id": ""      // non-empty while the radio is taken
}
```
Always `200`, even with no radio attached. A unit without an SDR is a working
unit with one fewer sensor ([ADR-0003](adr/0003-sensor-process-isolation.md)),
and the picker should say so rather than the page failing to load. The band list
comes from the sensor's own `BAND_PLANS` rather than a copy in Go, so the two
cannot drift.

### `POST /spectrum/sweeps`
```jsonc
{ "band": "ism_915" }
```
`202 Accepted` with the sweep object in `state: "running"`. The band is checked
against the sensor's plan before it reaches a subprocess argv.

- `400` — unknown band.
- `409` — a sweep is already running, or something else holds the radio (on a
  healthy unit, `dump1090`). Nothing is broken; the dongle is busy.
- `503` — this unit cannot sweep at all.

### `GET /spectrum/sweeps`
```jsonc
{ "sweeps": [ {
  "sweep_id": "01J8...", "band": "ism_915", "state": "completed",
  "started_at": "...", "ended_at": "...", "class": "E", "steps": 14,
  "noise_floor_dbfs": -70.5, "threshold_dbfs": -60.5,
  "peak_dbfs": -48.2, "peak_hz": 903412500,
  "short_reads": 0            // steps that read too short to transform
} ] }
```
`?limit=` bounds the page. The bins are deliberately absent: one sweep of
`fpv_1g2` is 146 steps of 1024 bins, so a list that carried them would cost
megabytes to answer "which sweeps do I have".

### `GET /spectrum/sweeps/{sweep_id}`
The sweep object plus the measurement:
```jsonc
{ "sweep_id": "01J8...", "state": "completed", /* ...as above... */
  "trace": {
    "start_hz": 901760000, "stop_hz": 928160000, "bin_width_hz": 22000,
    "dbfs": [-70.5, -71.2, null, -69.8],   // null = unmeasured, NOT quiet
    "blind": 14
  },
  "step_peaks": [ { "center_hz": 902960000, "peak_hz": 902341000, "peak_dbfs": -65.5 } ]
}
```

`?bins=` sets the trace width (default 1200, max 4096, never finer than the
measurement behind it).

**A `null` in `dbfs` is a frequency the receiver could not see, and a client
must render it as a gap rather than joining across it.** Two things produce one.
The RTL-SDR is zero-IF, so its own local oscillator lands at every step's tuned
frequency; the sensor guards three bins either side, leaving a ~16 kHz blind
notch every 1.92 MHz that the 20% step overlap does **not** close (it covers the
rolled-off step edges, not another step's centre). And a gap between distant
steps is spectrum nothing tuned to. Drawing a level across either shows a quiet
frequency that was never measured — which is the same lie `/telemetry` refuses
to tell with a null CPU temperature.

Overlapping steps are combined with max-hold, not averaged: a control-link burst
occupies a couple of bins out of a thousand, and averaging is exactly the
operation that buries it.

`trace` is absent — not empty — on a sweep that is still running or that failed.
An empty trace would chart as a flat, quiet band.

---

## Sensors

### `GET /sensors` — as the `sensors` array in `/health`, with full config.
### `POST /sensors/{id}/restart` — `202`. Restart-only; there is no "start transmitting".

---

## Monitoring

### `GET /monitoring`

Live state of the recording pause switch.

### `PUT /monitoring`

```jsonc
{ "enabled": false, "reason": "field maintenance" }
```

Pauses or resumes ingestion — the API stops accepting detections while paused. This does
**not** stop the sensor radios; they are separate processes the API cannot reliably signal,
so gating ingestion is the mechanism that works everywhere. The pause is in-memory only and
does not survive a restart: if the stack is up, it records, so a pause from a week ago can
never silently persist. `reason` is optional, max 200 characters.

---

## Config

### `GET /config/settings`

Every Tier 2 setting with its provenance ([ADR-0007](adr/0007-configuration-tiers.md)).
Returning values without `source` would recreate the bug that ADR was written against.

```jsonc
{
  "settings": {
    "retention.tracks":   { "value": "2160h", "source": "seed", "mutable": true,
                            "doc": "how long tracks are kept" },
    "bus.track_endpoint": { "value": "tcp://fusion:5557", "source": "env", "mutable": false }
  },
  "env_overridden": ["bus.track_endpoint"]
}
```

`source` is one of `env` · `db` · `seed` · `default`, in descending precedence.
`env_overridden` lets a UI explain why a field is read-only instead of looking broken.

### `PUT /config/settings`

Partial update; values are strings regardless of the setting's type, so every tier shares one
parser.

```jsonc
{ "retention.tracks": "720h", "sensors.stale_after": "45s" }
```

- `400 invalid_parameter` — unknown key, unparseable value, or a setting that is not mutable
- `409 conflict` — the key is currently held by the environment, which would silently ignore
  the stored value. Refused rather than accepted-and-ignored.
- Validation runs over the whole body before anything is written, so a body with one bad value
  leaves stored settings untouched rather than half-applied.
- `restart_required` is `true`: the process holds its assembled config in memory.

### `GET|PUT /config/channels` — the weighted channel plan.
### `GET|PUT /config/weights` — fusion confidence weights.

`PUT` validates and returns `400` with per-field errors on failure. Changes take effect
without a restart where possible; the response includes `"restart_required": bool`.

Both are `true` today, for different reasons, and the weights one is weaker than it looks:

- **Channels.** The hopper reads `channels.yaml` once at startup and sensors subscribe to
  nothing ([ADR-0002](adr/0002-message-bus-zeromq.md)), so a restart genuinely applies the
  stored plan.
- **Weights.** Fusion does not read a weights file at all — it starts from
  `fusion.DefaultWeights()`, compiled in. A stored plan is a record of intent that **no
  restart will apply**; see [data-model.md](data-model.md#confidence-scoring). The calibration
  page says so rather than showing a saved value as though it were live.

### `GET /admin/deployment/history` — past runs, newest first.

`?limit=` defaults to 20 and is capped at 50, which is what the agent keeps.
Each run carries its whole log, so an unbounded limit is a way to ask a Pi to
serialise megabytes.

```jsonc
{ "configured": true,
  "runs": [
    { "id": "1755500400-0d7d84d9",
      "started_at": "…", "finished_at": "…", "duration_s": 187,
      "result": "failed",
      "reason": "docker compose could not build the web tier; rolled back to b27953a5",
      "commit": "b27953a5…", "commit_subject": "…", "previous_commit": "0d7d84d9…",
      "artefacts": [{ "name": "pi-dash", "state": "current" }],
      "log": ["deploying b27953a5 -> 0d7d84d9", "…"] } ] }
```

Only runs that **did** something are recorded — `deployed`, `failed`,
`rebuilt`. A ten-minute timer that finds nothing to do would otherwise bury a
week's six real deploys under a thousand rows of "up to date".

`commit` is HEAD when the run **finished**, so a rolled-back run names the
commit it went back to; `previous_commit` is where it started. The agent writes
JSON Lines and the API skips a line it cannot parse rather than failing the
whole read: the file is appended to by a shell script on a box that can lose
power mid-write, and one torn line must not cost the other forty-nine records.

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

Session cookies, three roles, and optional OIDC single sign-on. This replaces the
"none in v1, bind to a trusted LAN" position, which stopped being defensible once
the unit joined a tailnet and grew an admin surface, a hook system that can be
pointed at arbitrary URLs, and a button that takes the radio away from ADS-B.

### Roles

Ordered, not a matrix: `viewer` < `operator` < `admin`.

| Role | Can |
|---|---|
| `viewer` | Read everything: tracks, detections, captures, spectrum, telemetry, settings |
| `operator` | Act on the hardware: start a capture, sweep a band, restart a sensor, change channels/weights/recording |
| `admin` | Change who exists, edit `config/settings`, manage sessions |

A permission matrix is the right answer when permissions are genuinely
orthogonal. These are not, and a matrix would be a configuration surface nobody
audits protecting three verbs.

**Every endpoint is closed unless it is explicitly public.** The public set is
`/health`, `/metrics`, and the login surface (`/auth/me`, `/auth/login`,
`/auth/logout`, `/auth/setup`, `/auth/sso/*`) — short enough to audit at a
glance. `/health` and `/metrics` stay open because a monitoring probe holds no
cookie, and a unit that only reports its health to authenticated callers cannot
be watched by the thing that notices it died; neither carries positions or
identities.

### First run

A unit with no accounts answers `409 setup_required` to everything and serves
only `POST /auth/setup`. There is no default password — shipping one is the most
reliable way to end up with an internet-facing box running `admin/admin`. Setup
creates the first `admin`, logs them in, and closes permanently.

### `GET /auth/me`
```jsonc
{ "authenticated": true, "auth_enabled": true, "setup_required": false,
  "user": { "user_id": "…", "username": "lee", "role": "admin", "disabled": false },
  "providers": [ { "id": "oidc", "label": "Company SSO" } ] }
```
Public, and always `200`: "nobody is logged in" is a normal answer, and it is how
the web app decides whether to draw the app, a login form, or the setup screen.

### `POST /auth/login` · `POST /auth/logout` · `POST /auth/password`

Login takes `{username, password}` and sets an `HttpOnly`, `SameSite=Lax`
session cookie (`Secure` when the request arrived over TLS). **A wrong username
and a wrong password return the identical `401` body** — distinguishing them
turns the login form into an account-enumeration oracle.

`SameSite=Lax` rather than `Strict` because Strict drops the cookie on the
top-level redirect back from an SSO provider, which breaks OIDC login outright.

`POST /auth/password` requires `current_password`, even though the caller is
already authenticated: it is what stops a borrowed unlocked browser becoming a
permanent takeover. It ends every *other* session for that user.

### Sessions

Opaque random tokens, not JWTs. The cookie is a lookup key and every request
checks the database — that costs a query and buys revocation that is actually
immediate. Disabling an account, changing a role, or killing a session takes
effect on the next request, not at the next expiry.

**The stored value is a SHA-256 of the token, never the token.** A database dump
— including the Turso replica, which leaves the unit by design — hands over no
usable session.

Expiry is a sliding 12 h (`CLASSG_SESSION_TTL`): active use slides it forward, so
an operator is not logged out mid-shift, and an abandoned browser stops working
overnight.

### Single sign-on

One generic OIDC provider — Google, Authentik, Keycloak, Entra and Okta all
speak discovery, and vendor-shaped integrations would be five code paths nobody
here can test. Configure `CLASSG_OIDC_ISSUER`, `CLASSG_OIDC_CLIENT_ID`,
`CLASSG_OIDC_CLIENT_SECRET` and `CLASSG_OIDC_REDIRECT_URL` together or not at
all; a half-configured provider fails at the first login attempt, which is the
worst moment to find out.

Identities are matched on `(issuer, subject)`, **never on email**. Email is a
claim a provider can change and, at some providers, one a user can set — matching
on it would mean anyone who can set an email claim can become an existing
operator.

Auto-provisioning is where that rule needed spelling out. On a first login it
looks for a local account with the same **username**, and the username may
itself be the email: `CLASSG_OIDC_USERNAME_CLAIM=email` says so outright, and
the default falls back to email whenever the provider sends no
`preferred_username`. So a username-derived-from-email must carry
`email_verified: true` before it is allowed to **link** to an account that
already exists; a provider that omits the claim counts as unverified.
*Creating* a fresh account from an unverified email is unaffected — that is
somebody's first login and takes nothing from anyone. The refusal is logged.

**SSO does not create accounts by default.** A provider that issues tokens to
anyone with a Google account would otherwise make "SSO configured" mean "anyone
on the internet is an operator". `CLASSG_OIDC_AUTO_PROVISION=true` opts in, and
`CLASSG_OIDC_ROLE` may be `viewer` or `operator` — never `admin`, which both the
config validator and the service refuse, because auto-provisioning admins hands
this unit to whoever runs the identity provider.

### Administration

`GET|POST /admin/users`, `PATCH|DELETE /admin/users/{user_id}`,
`GET /admin/sessions`, `DELETE /admin/sessions/{session_id}` — all `admin`.

Password hashes never appear in any response. Two refusals are deliberate and
both return `409`:

- **The last enabled admin** cannot be demoted, disabled or deleted. Doing so
  leaves a box recoverable only by editing the database by hand, which on a
  sealed field unit means a card reader.
- **You cannot delete the account you are signed in with.** It is almost always
  a misclick, and "disable" is what someone actually wants.

### Turning it off

`CLASSG_AUTH_MODE=off` disables authentication entirely and treats every request
as an admin. It exists for a bench unit on an isolated network. It is logged
loudly at startup, reported by `GET /system`, and shown as a banner in the web
app — an auth-disabled box that nobody remembers disabling is worse than one
that never had authentication.

### Errors

| Code | Status | Means |
|---|---|---|
| `unauthenticated` | 401 | No session, or it expired. Show the login screen. |
| `forbidden` | 403 | Logged in, wrong role. **Do not** bounce to login — the session is fine. |
| `setup_required` | 409 | No accounts exist yet. Show the setup screen. |

---

## Hooks

"When X happens, do Y." Admin-only, all of it — a hook is an egress path that
can send what this box sees to an arbitrary URL or mailbox, so configuring one
is administration of the machine rather than operation of it.

### `GET /admin/hooks`
```jsonc
{ "rules": [ {
    "rule_id": "01J8…", "name": "Drone confirmed", "enabled": true,
    "event": "track.confirmed",
    "min_confidence": 0.7, "only_drones": true,
    "classes": ["A","B"], "sensor_kinds": ["wifi"],
    "cooldown_s": 300,
    "action": "webhook",
    "config": { "url": "https://…", "authorization": "••••••••" },
    "last_fired_at": "…", "fire_count": 12
  } ],
  "events": [ { "event": "track.confirmed", "description": "…" } ],
  "smtp_configured": true }
```

`events` comes from the server so a client does not keep its own copy of the
closed set and drift from it. `smtp_configured` is there so the UI does not
offer an email hook on a unit with no mail server and only report the problem
when an alert fails to arrive.

### Events

| Event | Fires |
|---|---|
| `track.confirmed` | A track crossed the confidence threshold. **One alert per aircraft** — this is what most alerting wants. |
| `track.closed` | A track aged out. |
| `detection.created` | Every detection. High volume: one aircraft is several a second. |
| `sensor.unhealthy` · `sensor.recovered` | A sensor's health **changed**. Not every heartbeat. |
| `capture.completed` · `sweep.completed` | A capture or band sweep finished. |

Events fire on **transitions**, not on every message. A track alerts on
CONFIRMED rather than on every update; a sensor alerts when `healthy` flips
rather than on each unhealthy heartbeat — otherwise a dead adapter is six alerts
a minute for one fault, and a cooldown masking that would mask the recovery too.

### Cooldown

`cooldown_s` suppresses repeats **per rule and per subject** — the track, the
sensor, the capture. Not per rule.

That distinction is the whole design. One aircraft generates detections several
times a second; a per-rule cooldown would either flood on the first drone or go
silent for the second, and going silent for the second is the failure that
matters. Zero means the default (300s), not "no cooldown" — a rule with no
cooldown on `detection.created` sends thousands of messages, and nobody means
that.

Suppressed firings are **recorded**, not dropped silently. "Why did I not get an
alert" is a question an operator actually asks.

### Actions

`webhook` POSTs JSON. `email` needs `CLASSG_SMTP_*` configured on the unit —
server credentials are process configuration, not rule configuration, so the
password is not copied into every rule.

**Webhook targets are checked against SSRF**, by DNS resolution rather than by
string matching: `localhost`, `127.1`, and a name whose A record is `10.0.0.1`
are the same problem and only the first two look like it. Redirects are refused
outright, because a target that 302s to `169.254.169.254` would walk past a
check performed on the original URL. `hooks.allow_private_targets` opts in for a
genuinely local target such as Home Assistant.

### Secrets in `config`

Keys named `authorization`, `password`, `token`, `secret`, `bearer_token` or
`auth_header` are **write-only**. They come back as `"••••••••"` — present, so
the UI can show that a token is set, never readable.

Send the placeholder back on a `PUT` and it means **unchanged**. Without that
rule, renaming a hook through the UI would silently overwrite its bearer token
with bullet characters and the hook would start failing for a reason nobody
could see.

### `POST /admin/hooks/{rule_id}/test`

Sends one message through the rule immediately, **bypassing the cooldown**, and
returns the outcome synchronously:

```jsonc
{ "delivered": false, "response_code": 404, "error": "the target answered 404 Not Found" }
```

Always `200` — a target that refused the message is a fact about the target, not
an API failure. The cooldown is bypassed on purpose: a test button that silently
did nothing because the rule fired ten minutes ago would be worse than no test
button.

### `GET /admin/hook-deliveries`
```jsonc
{ "deliveries": [ {
    "delivery_id": "…", "rule_name": "Drone confirmed", "event": "track.confirmed",
    "subject": "01J8…", "status": "delivered",
    "attempts": 1, "response_code": 200, "created_at": "…", "completed_at": "…"
  } ],
  "dropped": 0 }
```

`status` is `delivered`, `failed`, `pending`, or `suppressed`. `dropped` counts
events discarded because the dispatch queue was full — surfaced here rather than
only on `/metrics`, because a silent drop in an alerting system looks exactly
like nothing happening.

Retries are 2s/4s/8s and bounded. A 4xx is not retried (the target is saying the
request is wrong; an unchanged retry is noise), except 408 and 429.

**Dispatch never blocks ingest.** Detections arrive off a socket with a
high-water mark, and a slow webhook must not become backpressure on the thing
that sees drones.

### Redaction

Hook payloads are built from the **redacted** track, the same value the
websocket receives. `CLASSG_EXPOSE_OPERATOR_LOCATION=false` strips the operator
position from a webhook exactly as it does from `/tracks` — a hook is not a door
around it.

---

## Deployment

`GET|POST|DELETE /admin/deployment[/deploy]` — admin.

**The API cannot deploy anything, by design.** It runs in a container and is
deliberately given no way to run `systemctl` on the host: handing a web-facing
process host control would make every bug in this API a host compromise.

So this is a file exchange with the host-side agent
([docs/ops/10-continuous-deployment.md](../ops/10-continuous-deployment.md)).
The agent writes its state after every run; the API reads it. `POST .../deploy`
writes a request marker the agent picks up on its next tick.

```jsonc
{ "configured": true,
  "commit": "f30b354…", "commit_subject": "Deploy main to the unit itself…",
  "last_check_at": "…", "last_result": "up-to-date", "last_reason": "",
  "remote_commit": "…", "remote_ci": "success",
  "timer_enabled": true, "update_available": false, "deploy_requested": false,
  "state_age_s": 214,
  "artefacts": [{ "name": "classg-sensor-sdr", "state": "current" },
                { "name": "pi-dash", "state": "rebuilt" }],
  "log": ["up to date at f30b354d"] }
```

`state_age_s` matters as much as `timer_enabled`: a large age means the agent is
not actually running, whatever the flag claims.

`last_deploy_at` / `last_deploy_commit` / `last_deploy_ok` describe the last run
that actually deployed, and are **carried forward** by every later check. They
used to be written only by the run that deployed, so the next timer firing ten
minutes later published a document without them and the admin page reported
"Last deploy: never" on a unit that had deployed twenty minutes earlier.

`artefacts` reports what the agent made of the things this unit builds for
itself — `current`, `rebuilt`, `failed`, `absent`. It is **absent, not empty**,
on the runs that deliberately skip the check (a busy unit, a dirty tree), and
that distinction is the reason the field exists: the agent's log only speaks
when it acts, so "checked and found current" and "never checked" are the same
silence, and pi-dash ran an old build for days inside it.

`configured: false` with a `reason` is the normal answer on a dev machine or a
unit that never installed the agent — not an error.

`POST .../deploy` returns `202` and says plainly that it means *queued*, not
*deploying*: the agent acts within ten minutes and still refuses if CI is not
green or a measurement is in progress.

---

## GraphQL

`POST /graphql` — viewer. Read-only.

One query, one round trip, only the fields asked for. It exists for a request
REST answers badly:

```graphql
{ tracks(states: ["CONFIRMED"], limit: 20) {
    tracks {
      track_id last_seen confidence
      detections(limit: 50) { detections { detection_id sensor_kind rf { freq_hz } } }
    }
} }
```

Over REST that is one list call plus one call per track, on a link that is often
a phone tethered to the unit's own access point.

**Field names are the JSON names from this document**, not camelCase —
`track_id`, not `trackId`. Four services already speak the contract's spelling
and `schemas/*.schema.json` is the authority for all of them; a second name for
every field would be a translation layer with nothing on the other side of it.

### What it deliberately does not do

- **No mutations.** Starting a capture, taking the radio for a sweep, creating a
  user and arming a hook each carry their own authorisation level and their own
  failure semantics — `409` when the radio is busy, `503` when a sensor is gone.
  Restating those in resolvers would mean two implementations of every rule, and
  the audited one would be the REST one. REST writes; GraphQL reads.
- **No admin surface.** Users, sessions, hook rules and their secrets, and
  deployment state have no resolver at all. They are admin-only in REST, and a
  viewer-level query language that could reach them would be a privilege
  escalation with extra steps. This is what makes a single role correct for the
  whole endpoint.
- **No `raw` on a detection.** The vendor IE bytes stay on
  `GET /detections`, where asking for them is deliberate.
- **POST only, no GraphiQL.** A GET carrying a query is cacheable and loggable
  by everything in the path, and detections carry positions. Introspection stays
  enabled so a client author can generate types against the live schema.

### Limits

A query is costed **before** any resolver runs, so a rejected one costs a parse
rather than a walk:

| Limit | Value | Why |
|---|---|---|
| Document size | 64 KiB | A query longer than this was not written by hand. |
| Depth | 8 | The schema's own deepest path is 6 and it has no cycle. This is headroom for the day `Detection` gains a back-reference to its track. |
| Top-level fields | 24 | Depth alone does not stop `{a: tracks{…} b: tracks{…} …}`, which is flat and runs the expensive resolver once per alias. |
| `limit` / `cursor` | Same bounds as REST | `store.NormaliseLimit`, so paging cannot be widened by changing protocol. |

Frequencies and byte counts use a **`Hz` scalar serialised as a decimal
string**, because GraphQL's `Int` is 32-bit and 2.4 GHz does not fit in one.

### Errors

GraphQL responses are `200` with an `errors` array — that is the GraphQL
contract, and a client library expects to find failures there. This API's
`{"error":{…}}` envelope is used only for failures *before* execution: a wrong
method, a body that is not JSON, an oversized document, a query over the cost
limits. Those are transport failures, not query failures.

Authentication is the exception and behaves like every other endpoint: no
session is `401` with the envelope, and an insufficient role is `403`.

### Operator location

Redacted at the same switch, in the same place as every other read path —
`CLASSG_EXPOSE_OPERATOR_LOCATION`. Redaction happens where rows leave the store,
not in a resolver for the `operator` field, so a type added to the schema later
cannot route around it.

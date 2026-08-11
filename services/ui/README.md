# ui (Vite + MapLibre) — Milestone 1

Implemented as a static React application. The Go API serves `dist/` in deployment; in
development, Mock Service Worker supplies deterministic API and WebSocket scenarios.

```bash
npm ci
npm run dev       # mock data by default
npm test
npm run build
```

Set `VITE_USE_MSW=false` to use a real API through the Vite proxy.
Vite loads `VITE_*` settings from the repository-root `.env`, shared with the API
and sensors. See `docs/ops/00-configuration.md`.

## Why MapLibre

Offline tiles. A field-deployed Pi has no internet, and a drone-detection map that needs a
tile CDN is useless exactly when you'd want it. MapLibre + a self-hosted TileServer handles
this; the approach is borrowed from
[RemoteIDReceiver](https://github.com/cyber-defence-campus/RemoteIDReceiver).

The container uses Esri World Imagery as a satellite basemap. It serves build-seeded tiles
first, fetches missing tiles while online, and retains runtime downloads in the
`classg-tile-cache` Docker volume. Set `CLASSG_TILE_PRELOAD_BBOX=west,south,east,north`
before `docker compose build` to seed an operations area at zoom levels 12–15. If neither
the cache nor internet is available, the map keeps its range-ring fallback.

Esri rather than the public-domain USGS imagery this used to serve, because USGS
`ImageryOnly` has no pixels past **z16** (1.66 m/px at the receiver) and 404s above it — so
the track detail view, which fits to z19, was showing an 8× upsample of the sharpest tile
that existed. Esri carries real imagery to **z19** (0.21 m/px). The trade is licensing:
USGS is public domain, Esri's basemap is free-to-use **with attribution** under
[Esri's terms](https://www.esri.com/en-us/legal/terms/full-master-agreement), not public
domain. To go back, or to move to a keyed source such as Mapbox or MapTiler, see
[Satellite basemap cache](../../docker/README.md#satellite-basemap-cache).

## Views

**Live map** — track markers coloured by confidence, not by an invented threat level. Heading
arrows from kinematics. Trails from track history. Manned ADS-B traffic rendered distinctly so
it is never mistaken for a drone.

**Track detail** — identity, evidence breakdown by class, position history, RSSI over time.
Show _why_ something is a detection: "Class A (Remote ID) × 402, Class B (DJI) × 398" is
honest in a way that a bare "94% confident" is not.

**Sensor health** — per-sensor heartbeat status, prominent. The operator must be able to tell
at a glance whether an empty map means empty sky or broken sensor.

**Event log** — a client-side record of what this console observed while it was open: stream
connects and drops, track lifecycle, sensor health transitions, captures, API failures and
operator actions. Transitions only, never the 1 Hz frame stream, or the one line that matters
is buried. It is bounded, in-memory, exportable as NDJSON or CSV, and explicitly _not_ the
system's log — the sensors and API keep their own on the Pi and those are the forensic record.

**Settings** — display preferences, stored in this browser: unit system (metric / aviation /
imperial), coordinate format, time zone and clock, text size, density, audible new-track
alert, screen wake lock. Distinct from **Config**, which changes the instrument itself
(channel dwell, fusion weights) on the server for every client.

## Type

Three families, each with a job. `Inter` for reading — body text, tables, forms. `Manrope`,
the approved brand face, for the wordmark, page titles and large numerals. `JetBrains Mono`
for identifiers, where a slashed zero and a disambiguated `1/l/I` matter because the string
_is_ the evidence. All bundled locally: a Pi in the field has no route to a font CDN.

Inter and JetBrains Mono keep their full subset coverage because they render data we do not
control — an SSID can be Cyrillic. Manrope only sets our own English strings, so it ships
latin-only.

## Units

Everything is stored and transmitted in SI, and converted only at render time by
`useFormat()` (`src/app/use-format.ts`). No component formats a measurement itself, so
switching unit system cannot change what was recorded — only how it is written down.

## Two things not to build

- **No threat scoring.** The data model deliberately has no threat field. Rendering confidence
  as a threat level would smuggle a policy judgement into the UI.
- **No independent operator-location lookup.** The UI renders operator position only when the
  API includes it; it never works around the API's exposure policy.

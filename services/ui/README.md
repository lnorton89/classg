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

## Two things not to build

- **No threat scoring.** The data model deliberately has no threat field. Rendering confidence
  as a threat level would smuggle a policy judgement into the UI.
- **No independent operator-location lookup.** The UI renders operator position only when the
  API includes it; it never works around the API's exposure policy.

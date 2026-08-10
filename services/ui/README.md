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

The container uses public-domain USGS imagery as a satellite basemap in the United States.
It serves build-seeded tiles first, fetches missing tiles while online, and retains runtime
downloads in the `classg-tile-cache` Docker volume. Set
`CLASSG_TILE_PRELOAD_BBOX=west,south,east,north` before `docker compose build` to seed an
operations area at zoom levels 12–15. If neither the cache nor internet is available, the
map keeps its range-ring fallback.

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

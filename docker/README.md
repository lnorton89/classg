# Docker: use it where it helps, not everywhere

**Recommended split on the Pi:**

| Component | Where | Why |
|---|---|---|
| `sensor-wifi`, `sensor-sdr`, `sensor-ble` | **systemd on the host** | Need raw USB access, monitor-mode interfaces, and network-namespace visibility |
| `fusion`, `api`, `ui`, storage | **containers** | Dependency isolation for the web stack, easy rebuilds, no hardware coupling |

Containerising the sensors is usually more friction than it's worth:

- Monitor-mode interfaces live in the **host** network namespace. `network_mode: host`
  works, but you've now given up the isolation that was the reason to containerise.
- USB device passthrough needs `--privileged` or careful `--device` mapping, and **breaks on
  replug** — the device node changes and the container doesn't follow it. Given that a wedged
  or replugged adapter is an expected failure mode here (see
  [ADR-0003](../docs/architecture/adr/0003-sensor-process-isolation.md)), that's a bad trade.
- systemd already gives exactly what the sensors need: supervision, restart backoff, and
  `ExecStartPre=` for monitor-mode setup.

So: `docker-compose.yml` covers the web tier. Sensors get systemd units —
templates and installer in [deploy/systemd](../deploy/systemd), full procedure
in [docs/ops/09-deployment.md](../docs/ops/09-deployment.md).

## Web tier

```bash
cp .env.example .env
make compose-up
```

Then open `http://localhost:8080`. The API is also exposed at
`http://localhost:8081/api/v1` for CLI testing.

### Satellite basemap cache

The UI proxies Esri World Imagery through a persistent Docker cache. To bake the
expected operations area into the UI image as well, set a WGS84 bounding box before building:

```dotenv
CLASSG_TILE_PRELOAD_BBOX=-122.35,47.60,-122.32,47.62
CLASSG_TILE_PRELOAD_MIN_ZOOM=12
CLASSG_TILE_PRELOAD_MAX_ZOOM=15
```

Keep the area tight: tile count grows approximately fourfold per added zoom level. The build
fails before downloading if the request exceeds `CLASSG_TILE_PRELOAD_MAX_TILES`. An offline
build still succeeds; unavailable tiles are fetched and cached later when the stack has
internet access.

Preload zoom accepts up to 19, but budget for it — seeding the bbox above through z19 is
roughly 4⁴ ≈ 256× the z15 tile count. The on-demand cache fills the deep levels for wherever
you actually fly, which is usually the better trade than baking them all in.

> **Don't publish an image built with a preload bbox.** Fetching and caching tiles as you
> fly is ordinary use of the imagery service. Baking them into an image and pushing that
> image to a registry is **redistribution**, which Esri's terms don't permit. Building
> privately and running it on your own Pi is fine; `docker push` to anywhere public is not.
>
> This constraint arrived with the Esri switch — USGS imagery is public domain, so baking
> and shipping it was unrestricted. It is unrelated to ClassG's own MIT license, which
> covers this source tree and cannot grant rights to third-party imagery.
>
> If you need a publishable image, leave `CLASSG_TILE_PRELOAD_BBOX` empty and let the
> runtime cache fill it in the field. That is the default, and `public/tiles/basemap` is
> build-generated and untracked, so nothing leaks through git either way.
>
> Pointing `CLASSG_SATELLITE_TILE_URL` at the public-domain USGS endpoint would make the
> *baked* tiles redistributable, but it is a poor trade: nginx still proxies Esri at
> runtime, so the image would carry USGS tiles up to z15 and serve Esri above it. Different
> imagery vintages meet mid-map, and the colour and season shift visibly at the seam.

#### Changing the imagery source

The default has real pixels to **z19**. Zoom ceilings are per-source and per-location;
measured at the receiver (47.6062, -122.3321):

| Source | Ceiling | Ground resolution | License |
|---|---|---|---|
| Esri World Imagery *(default)* | z19 | 0.21 m/px | Free with attribution, [Esri terms](https://www.esri.com/en-us/legal/terms/full-master-agreement) |
| USGS `ImageryOnly` *(previous)* | z16 | 1.66 m/px | Public domain |
| Mapbox / MapTiler satellite | z20–22 | ≤0.10 m/px | API key, metered |

Past its ceiling Esri returns a grey *“Map data not yet available”* tile at **HTTP 200** —
not a 404 — so an over-set ceiling blanks the map instead of blurring it. Three places must
agree when you switch:

1. `services/ui/nginx.conf` — the `@satellite_tile` upstream and rewrite (production).
2. `services/ui/vite.config.ts` — the `/tiles/basemap/{z}/{x}/{y}.jpg` proxy, or
   `VITE_SATELLITE_TILE_ORIGIN` (dev).
3. `services/ui/src/features/map/style.ts` — `BASEMAP_MAX_ZOOM`.

`CLASSG_SATELLITE_TILE_URL` overrides the build-time preloader only; it does not change what
nginx proxies at runtime. To confirm a candidate's real ceiling before committing to it,
request tiles directly and watch for the status flip or a suspiciously small, identical
response body at successive zooms.

The dev proxy key is a **regex**, deliberately matching nginx's `location ~` exactly. It used
to be the bare prefix `/tiles/basemap`, which also swallowed `/tiles/basemap.pmtiles` and
forwarded the vector archive to ArcGIS — so the vector basemap 404'd in dev while working in
production. Any new path sharing a leading segment with a proxy key goes upstream silently;
scope the key rather than the handler.

#### Or skip the imagery problem entirely

The vector basemap has none of the above: no zoom ceiling to keep three files in agreement
about, no upstream at runtime, and no redistribution question, because Protomaps builds are
OpenStreetMap data rather than licensed imagery. It is one file in `public/tiles/`:

```bash
./scripts/fetch-basemap.sh -122.45 47.50 -122.20 47.72 14
```

It is not the default because it trades photographic detail for drawn shapes, which is the
wrong trade for identifying a landing site and the right one for a unit with no uplink. See
[docs/ops/07-external-data.md](../docs/ops/07-external-data.md).

## Crossing the container boundary

The sensors stay on the host, so the detection bus has to cross into Compose.
The direction is chosen, not incidental: fusion **listens** on 5556 and Compose
publishes that port **on loopback only** (`127.0.0.1:5556` — the bus has no
authentication, and the host sensors dial loopback; `CLASSG_BUS_BIND=0.0.0.0`
re-exposes it for remote sensors on a trusted network). The host sensor
**connects** outward to it. Fusion then relays detections and heartbeats to
the API over the private Compose network.

That is the reverse of the all-native layout, where the sensor binds and fusion
dials. It has to be, because a container's loopback is not the host's: a sensor
bound to `127.0.0.1:5556` on the host is invisible from inside fusion's network
namespace, and giving the whole web tier `network_mode: host` to paper over it
hands back the isolation that was the reason to containerise it.

Validate the files without starting containers:

```bash
make compose-config
```

Start the web tier first, then replay a flight. Replay publishes by default.
A fresh clone has no captures — the corpus is gitignored — so generate the
synthetic one (see the README's "Prove the pipeline without hardware"):

```bash
make compose-up
services/sensor-wifi/.venv/bin/python scripts/make-demo-capture.py
cd services/sensor-wifi
.venv/bin/python -m classg_wifi.cli replay ../../captures/demo-hover.pcap \
  --endpoint tcp://127.0.0.1:5556 --socket-mode connect
curl -s http://localhost:8081/api/v1/health
```

`/health` answers without a session and should show `wifi-0` healthy with 500
detections. `/api/v1/detections` shows the detections themselves once you have
a session (or `CLASSG_AUTH_MODE=off` on a dev box). A capture of your own
replays the same way.

Use `--no-publish --print` when you only want the old parser-only console
output.

With the web tier in Compose, `.env` needs the sensor pointed at the published
port in connect mode:

```dotenv
CLASSG_DETECTION_ENDPOINT=tcp://127.0.0.1:5556
CLASSG_WIFI_SOCKET_MODE=connect
```

An all-native deployment (`make dev-native`) keeps the committed defaults: the
sensor binds `127.0.0.1:5556` and fusion dials it.

## If you really want sensors in containers

For a dev machine where hardware isn't attached, or CI:

```yaml
sensor-wifi:
  build: ../services/sensor-wifi
  network_mode: host
  cap_add: [NET_ADMIN, NET_RAW]
  devices:
    - /dev/bus/usb:/dev/bus/usb
```

Expect to restart the container after any adapter replug. This is fine for replaying PCAPs
(`classg-sensor-wifi replay`), which needs no hardware at all — and that's the case where
containers genuinely earn their keep here.

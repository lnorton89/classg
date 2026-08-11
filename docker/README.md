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

So: `docker-compose.yml` covers the web tier. Sensors get systemd units.

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
CLASSG_TILE_PRELOAD_BBOX=-122.78,46.03,-122.75,46.05
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

#### Changing the imagery source

The default has real pixels to **z19**. Zoom ceilings are per-source and per-location;
measured at the receiver (46.0400, -122.7673):

| Source | Ceiling | Ground resolution | Licence |
|---|---|---|---|
| Esri World Imagery *(default)* | z19 | 0.21 m/px | Free with attribution, [Esri terms](https://www.esri.com/en-us/legal/terms/full-master-agreement) |
| USGS `ImageryOnly` *(previous)* | z16 | 1.66 m/px | Public domain |
| Mapbox / MapTiler satellite | z20–22 | ≤0.10 m/px | API key, metered |

Past its ceiling Esri returns a grey *“Map data not yet available”* tile at **HTTP 200** —
not a 404 — so an over-set ceiling blanks the map instead of blurring it. Three places must
agree when you switch:

1. `services/ui/nginx.conf` — the `@satellite_tile` upstream and rewrite (production).
2. `services/ui/vite.config.ts` — the `/tiles/basemap` proxy, or `VITE_SATELLITE_TILE_ORIGIN` (dev).
3. `services/ui/src/features/map/style.ts` — `BASEMAP_MAX_ZOOM`.

`CLASSG_SATELLITE_TILE_URL` overrides the build-time preloader only; it does not change what
nginx proxies at runtime. To confirm a candidate's real ceiling before committing to it,
request tiles directly and watch for the status flip or a suspiciously small, identical
response body at successive zooms.

## Windows + custom WSL kernel

The custom ClassG kernel is a global WSL setting, so Docker Desktop's WSL 2
engine may fail to boot under it. Run Docker on the Windows side instead:

1. In Docker Desktop, clear **Settings → General → Use the WSL 2 based engine**
   so Docker Desktop uses its Windows-managed Hyper-V Linux VM.
2. Start Docker Desktop from Windows.
3. From the ClassG WSL shell, run `make compose-up`.

The first switch from WSL to Hyper-V may require one Windows reboot so the
privileged Docker service recreates its backend pipes. If `docker version`
shows a client but no server immediately after the switch, reboot once before
troubleshooting the project.

`scripts/docker.sh` deliberately selects Windows `docker.exe` when it detects
WSL. Do not install or start a second Docker daemon inside the custom distro.
The Compose client still feels native from WSL, but the engine and its kernel
are owned by Windows.

Compose exposes detection ingress on Windows port 5556. The WSL Wi-Fi sensor
connects outward to `host.docker.internal:5556`; fusion receives those messages
and relays detections and heartbeats to the API on the private Compose network.
This avoids dynamic WSL IP addresses and replaces Linux-only
`network_mode: host`.

Validate the files without starting containers:

```bash
make compose-config
```

Start the web tier first, then replay the captured flight from WSL. Replay now
publishes by default:

```bash
make compose-up
cd services/sensor-wifi
.venv/bin/python -m classg_wifi.cli replay \
  ../../captures/20260810-141223-dji-first-flight.pcap
curl http://localhost:8081/api/v1/detections
```

Use `--no-publish --print` when you only want the old parser-only console
output.

For this Windows/WSL layout, `.env` needs:

```dotenv
CLASSG_DETECTION_ENDPOINT=tcp://host.docker.internal:5556
CLASSG_WIFI_SOCKET_MODE=connect
```

Native Linux/Pi deployments keep the committed defaults (`127.0.0.1` and
`bind`), with fusion configured to `dial`.

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

# External data sources

Five free sources ClassG can use. Every one of them is **off by default**, and
every one degrades to exactly the behaviour that existed before it — a missing
file or a dropped uplink costs enrichment, never detection.

| Source | What it adds | Needs a uplink at runtime? |
|---|---|---|
| [adsb.lol](https://api.adsb.lol/docs) | Manned traffic for Class D correlation, with no SDR fitted | **Yes** |
| [OpenTopoData](https://www.opentopodata.org/) | Real `height_agl_m` from geodetic altitude minus terrain | No, if self-hosted |
| [OpenSky aircraft database](https://opensky-network.org/datasets/metadata/) | Registration and type for ADS-B contacts | No |
| [IEEE MA-L registry](https://standards-oui.ieee.org/) | Every OUI a drone vendor actually holds | No |
| [Protomaps](https://protomaps.com) / [OpenFreeMap](https://openfreemap.org) | A vector basemap that works with the uplink unplugged | No, with Protomaps |

```bash
make data
```

fetches the two that need no arguments. The basemap needs a bounding box, so it
has its own script.

## Two rules that shaped all of this

**Nothing here may gate detection.** Each of these is treated exactly like a
sensor under [ADR-0003](../architecture/adr/0003-sensor-process-isolation.md):
a degraded state with an operator-visible reason, never an exception and never a
crash. The network ADS-B feed heartbeats onto the same topic a radio does and
appears in `/health` alongside them.

**Nothing detected leaves the unit.** Every integration here is inbound only.
`operator.lat/lon` is a real person's ground position
([ADR-0006](../architecture/adr/0006-operator-location-retention.md)), and a
detector that quietly posted its findings to a third party would be a different
product from the one described in
[docs/research/06-legal-and-ethics.md](../research/06-legal-and-ethics.md). The
outbound requests are: a bounding-box query to an ADS-B aggregator (which
reveals roughly where the unit is), and terrain lookups near tracked aircraft.
Both are off unless switched on, and both can be pointed at something you run.

---

## Network ADS-B (adsb.lol)

Class D exists to explain detections away, not to raise confidence — its weight
is pinned at `0.00`. The SDR is the better source for it, because it proves what
this antenna can hear. This feed is for units with no SDR fitted, and for the
terrain shadow every ground-level receiver has.

```bash
CLASSG_FUSION_NET_ADSB=true
CLASSG_RECEIVER_POSITION=47.6062,-122.3321
```

| Setting | Env | Default | Notes |
|---|---|---|---|
| `fusion.net_adsb` | `CLASSG_FUSION_NET_ADSB` | `false` | |
| `map.receiver_position` | `CLASSG_RECEIVER_POSITION` | — | Required. `0,0` is rejected as unset, not treated as the Gulf of Guinea |
| `fusion.net_adsb_url` | `CLASSG_FUSION_NET_ADSB_URL` | `https://api.adsb.lol` | adsb.fi and airplanes.live serve a compatible `/v2/point` |
| `fusion.net_adsb_radius_nm` | `CLASSG_FUSION_NET_ADSB_RADIUS_NM` | `25` | 250 nm ceiling |
| `fusion.net_adsb_interval` | `CLASSG_FUSION_NET_ADSB_INTERVAL` | `10s` | |
| `fusion.net_adsb_sensor_id` | `CLASSG_FUSION_NET_ADSB_SENSOR_ID` | `net-adsb-0` | |

The receiver position is the **same** key the map centres on. A unit has one
position, and a map centred somewhere the traffic query is not would be worse
than either alone — so there is deliberately no separate latitude/longitude
pair for the feed. Set it on the Settings › Calibration page, in
`config/defaults.yaml`, or as the env override above.

To see the feed on the sensors page before its first poll — including when it
never polls at all, which is the case that matters — declare it in
`sensors.expected`; `config/defaults.yaml` carries a commented entry.

A bad position or an over-range radius is fatal at startup rather than degraded
at runtime — an operator who asked for airspace context and silently got none
would read an empty sky as a quiet one. A *dropped uplink* is the opposite: it
is the expected condition, and it shows up as an unhealthy `net-adsb-0` on the
sensors page with the HTTP error as its reason.

Aircraft on the ground are filtered out. Near an airport they are most of the
response, they cannot be confused with a drone in flight, and every one is a row
in the database and a symbol on the map. Fixes older than the 60 s contact
window are dropped too. Both counts are visible in the heartbeat detail.

### Why `sensor_kind: "net"` and not `"sdr"`

Because it isn't one. A network feed has different failure modes (an uplink, not
an antenna), different latency, and — the part that matters — it proves nothing
about what *this* unit can hear. The sensors page draws it with a cloud rather
than an antenna for the same reason, and offers no restart button, because it
runs inside fusion and `classg-sensor-net.service` does not exist.

## Terrain elevation (OpenTopoData)

`alt_geodetic_m` on its own is close to meaningless: 400 m over the river and
400 m over the ridge behind it are the same number and very different
situations. Subtracting ground elevation is what produces the field an operator
actually reads.

```bash
CLASSG_FUSION_TERRAIN=true
CLASSG_FUSION_TERRAIN_GEOID_OFFSET_M=-22
```

| Setting | Env | Default | Notes |
|---|---|---|---|
| `fusion.terrain` | `CLASSG_FUSION_TERRAIN` | `false` | |
| `fusion.terrain_url` | `CLASSG_FUSION_TERRAIN_URL` | `https://api.opentopodata.org` | Point at a local instance |
| `fusion.terrain_dataset` | `CLASSG_FUSION_TERRAIN_DATASET` | `srtm30m` | Any dataset the instance serves |
| `fusion.terrain_min_interval` | `CLASSG_FUSION_TERRAIN_MIN_INTERVAL` | `1s` | `0` when self-hosted — the one duration setting that accepts zero |
| `fusion.terrain_geoid_offset_m` | `CLASSG_FUSION_TERRAIN_GEOID_OFFSET_M` | `0` | **Read the next paragraph** |

### The geoid offset is not optional in practice

SRTM and NED report **orthometric** height, above the geoid. Remote ID reports
height above the **WGS-84 ellipsoid**. The two differ by the local geoid
undulation — roughly −22 m around Seattle, and up to 100 m elsewhere in the
world. Leaving the offset at `0` does not disable the correction; it applies a
wrong one, and wrong in the direction that makes flights look *lower* than they
are. Fusion logs a warning at startup when it is unset.

Look yours up (NGS GEOID18 for the US, or any online EGM96 calculator) and set
it once. It is a property of where the unit is, not of the flight.

### Derived heights are marked as derived

A track position gains `terrain_elevation_m` when — and only when — fusion
computed `height_agl_m` itself. Its absence next to a height means the aircraft
reported that height. A height the aircraft reported is never overwritten: it is
measured against its own take-off point or barometer, which beats an inference.

Lookups are cached on a ~33 m grid, matching SRTM's actual resolution, and are
never made on the ingest path — a cache miss returns immediately and schedules
a fetch, so the first fix over new ground has no AGL and the next one does.
Fusion's ingest loop cannot afford to wait on a tile server.

### Running it locally

This is the integration most worth self-hosting: terrain does not change, so a
local instance gives identical answers forever with nothing leaving the unit.

```bash
docker run --rm -p 5000:5000 -v "$PWD/srtm:/app/data/srtm30m" opentopodata/opentopodata
```

```bash
CLASSG_FUSION_TERRAIN_URL=http://localhost:5000
CLASSG_FUSION_TERRAIN_MIN_INTERVAL=0
```

## Aircraft metadata (OpenSky)

```bash
make data-aircraft
CLASSG_FUSION_AIRCRAFT_DB=data/aircraft-database.csv   # or fusion.aircraft_db
```

Turns `contact A1B2C3` into `N512UP, a Cessna 208` in fusion's logs. Loaded once
at startup and never consulted over the network — the live OpenSky REST API is
credit-metered and would answer the same question about a field that never
changes.

Columns are read by name, so a reordered or renamed export still loads; a file
with no `icao24` column is rejected rather than silently misread. The whole file
is held in memory (order of tens of megabytes for the ~500k-row complete
export); the row count is logged at startup, so check it against the process
rather than trusting an estimate. On a small Pi, filter the CSV first — the
loader does not care how it was produced.

**Known limit:** this reaches fusion's logs and its in-memory contacts, not the
map. Contacts have no API resource of their own yet, so the UI still draws
manned traffic from Class D detections, which carry only the hex address. The
network feed is unaffected — adsb.lol returns registration and type in its own
response.

## IEEE OUI registry

```bash
make data-oui   # writes services/sensor-wifi/data/ieee-oui.csv
```

The path is `sensors.oui_registry` (`CLASSG_WIFI_OUI_REGISTRY`), and the Wi-Fi
CLI also takes `--oui-registry`.

`data/oui_fingerprints.yaml` lists OUIs by hand, transcribed from whatever
anyone observed — which misses the blocks nobody wrote down, and leaves entries
unverified. (One DJI OUI in that file carries a comment saying exactly that.)

`oui_owner_patterns` fixes both. At load, each pattern is matched against IEEE
registrant names and every block assigned to a matching organisation is added:

```yaml
  - vendor: autel
    oui_owner_patterns:
      - "autel robotics*"
```

Keep patterns as specific as the vendor name allows. `*autel*` also matches
Autel Intelligent Technology, who make OBD-II scan tools, and every block of
theirs would put a Class C hit on every car that drove past.

A match sourced from the registry is reported with the reason `oui_ieee` rather
than `oui`, and that reaches the stored detection as its parser name — so a
false positive can be traced to the rule that produced it. A pattern matching no
registrant is logged as a warning, because the failure mode is detecting less
than configured while looking fine.

Absent file, absent expansion: the hand-listed OUIs remain the baseline. This
changes nothing about what Class C *means* — it still identifies the
manufacturer of a radio, not an aircraft, and fusion still caps it at `0.10`.

## Vector basemap (Protomaps / OpenFreeMap)

```bash
VITE_BASEMAP_VECTOR_URL=/tiles/basemap.pmtiles
```

The UI probes three sources in order: vector, then the satellite raster proxy,
then range rings. Vector wins when configured because it is the only one that is
genuinely offline-complete.

### Protomaps — one file, no server

```bash
./scripts/fetch-basemap.sh -122.6 47.4 -122.1 47.8 14
```

Cuts a `.pmtiles` archive into `services/ui/public/tiles/`, read over HTTP range
requests by whatever already serves the app. This retires two traps at once:

- **The zoom ceiling.** `BASEMAP_MAX_ZOOM` has to agree across `nginx.conf`,
  `vite.config.ts` and `style.ts`, because Esri answers past its ceiling with a
  grey placeholder at HTTP 200 rather than a 404. Vector tiles scale, so there
  is no ceiling to keep in agreement.
- **Redistribution.** `docker/README.md` warns against publishing an image built
  with a preload bbox because it redistributes Esri imagery. Protomaps builds
  are ODbL OpenStreetMap data and ship fine, with attribution.

The style is hand-written rather than pulled from a theme package, for reasons
worth knowing before you change it: it has **no text layers**, so it needs no
glyph server and stays self-contained offline, and its palette is deliberately
recessive so the cyan and magenta of the tracks stay the brightest thing on
screen. Place names would compete with the aircraft labels for the same pixels.

### OpenFreeMap — no key, no setup, online only

```bash
VITE_BASEMAP_VECTOR_URL=https://tiles.openfreemap.org/styles/liberty
```

Any MapLibre style URL works. It arrives styled as its author intended rather
than in the palette above, and it needs the uplink — so it is the better choice
for a desk and the worse one for a field unit.

### The probe

MapLibre treats a missing basemap as silent, and an SPA server answers an
unknown path with `index.html` and HTTP 200 — so "the request succeeded" proves
nothing. For an archive the probe reads the first seven bytes and checks the
`PMTiles` magic, which an HTML fallback cannot fake. Check the attribution in
the bottom-right corner to confirm which source you actually got.

### Outside the bbox, an archive looks exactly like no archive

An extract contains only the area you cut. Pan outside it and the map goes to
the background colour with the range rings still drawn — visually identical to
having no basemap at all, except that the attribution still says Protomaps and
the probe still passed. There is no "you have left the coverage" state, because
nothing distinguishes empty tiles from absent ones.

Seen during bring-up: a Seattle extract with the stored flight tracks at
Longview, 170 km south, renders a black map at every zoom. If the map is blank,
check the bbox you cut against where the aircraft actually are before suspecting
the archive.

### Three things that bit during bring-up

**The dev container will not have a newly added npm package.** `node_modules`
is a named volume that outlives the container, and the install used to be
guarded by "does vite exist". Adding `pmtiles` on the host updated
`package.json` and the lockfile, the container kept its old volume, and Vite
failed with *Failed to resolve import "pmtiles"* for a package sitting in plain
sight in `package.json`. The guard now compares the lockfile against a stamp
inside the volume, so a stale one reinstalls. If you ever need to force it:
`docker volume rm classg_ui-node-modules`.

**`/tiles/basemap` was a proxy prefix, not a path.** nginx scopes the satellite
proxy with an exact regex; the Vite dev proxy used a bare prefix, which also
matched `/tiles/basemap.pmtiles` and forwarded the archive to ArcGIS. The dev
proxy is now the same regex as nginx. Worth remembering the general shape: a
Vite proxy key matches by prefix, so any new path sharing a leading segment
with an existing key silently goes upstream.

**Setting a leading-slash value from Git Bash mangles it.** `VITE_BASEMAP_VECTOR_URL=/tiles/basemap.pmtiles`
becomes `C:/Program Files/Git/tiles/basemap.pmtiles` under MSYS path
conversion. Set it in `.env`, which is unaffected, or prefix the command with
`MSYS_NO_PATHCONV=1`.

### Editing the style

The layer names and `kind` values in `vectorStyle()` were read out of a real
extract, not from the schema docs, because the first version passed every test
while being visibly wrong — `major_road` is a kind of its own, so treating only
`highway` as major drew arterials as hairlines, and a `kind != 'highway'` minor
layer also caught `ferry`, `rail` and `aeroway`, drawing ferry routes as roads
across open water. If you add a layer, check it against tile data first:

```bash
go-pmtiles tile services/ui/public/tiles/basemap.pmtiles 13 1312 2861 > tile.mvt
```

then decode it — the values are in the MVT string table, and a `strings`-style
scan will not do, because protobuf packs adjacent strings with no separator.

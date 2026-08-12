/**
 * Map styles.
 *
 * A field-deployed Pi has no internet. MapLibre was chosen precisely so tiles can
 * be self-hosted, but the honest default is that there may be no tiles at all —
 * so there are three styles here and the app picks between them by probing.
 *
 * The no-tile style is deliberately not a blank void: it draws range rings and
 * bearing spokes around the view centre, which gives distance and bearing sense
 * without any basemap. A drone 400 m out on a bearing of 310 is still readable.
 *
 * `vector` outranks the others when configured, because it is the only one of
 * the three that is genuinely offline-complete: a single `.pmtiles` archive on
 * the Pi's own disk, no proxy, no upstream, no zoom ceiling to keep three files
 * in agreement about, and none of the redistribution problem that stops the
 * satellite cache being baked into an image.
 */
import type { StyleSpecification } from 'maplibre-gl'

/** Where self-hosted tiles live, relative to the Vite base. */
export const TILE_PATH = 'tiles/basemap/{z}/{x}/{y}.jpg'

/**
 * Deepest zoom the upstream imagery actually has pixels for.
 *
 * This is a property of whichever source `/tiles/basemap` proxies to, so it must
 * be changed together with the upstream in `nginx.conf`, `vite.config.ts`, and
 * `scripts/preload-satellite-tiles.mjs`. Measured at the receiver's location
 * (47.6062, -122.3321):
 *
 *   USGSImageryOnly   z16 -> 200, z17+ -> 404          (1.66 m/px ceiling)
 *   Esri World Imagery z19 -> 200, z20+ -> "Map data
 *                      not yet available" placeholder  (0.21 m/px ceiling)
 *
 * Setting this too high is worse than too low: Esri answers past its ceiling
 * with a grey placeholder tile at HTTP 200, so the map would go blank rather
 * than blurry. Too low and MapLibre upsamples, which is what made a z16 source
 * viewed at z19 -- an 8x magnification of the sharpest tile that existed --
 * look like the smeared mush it did.
 */
export const BASEMAP_MAX_ZOOM = 19

const BASEMAP_ATTRIBUTION =
  '<a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank">Esri World Imagery</a>'

export type BasemapMode = 'vector' | 'tiles' | 'no-tiles'

/**
 * Vector basemap source, if one is configured. Two forms are accepted:
 *
 *   …/basemap.pmtiles          a Protomaps archive, read directly over HTTP
 *                              range requests. Put the file in `public/` and it
 *                              is served by whatever already serves the app —
 *                              no tile server, and it works with the uplink
 *                              unplugged.
 *   https://…/styles/liberty   any MapLibre style URL, e.g. OpenFreeMap, which
 *                              is free and needs no key. Online only, and it
 *                              arrives styled as its author intended rather
 *                              than in the recessive palette below.
 */
export const BASEMAP_VECTOR_URL: string = import.meta.env.VITE_BASEMAP_VECTOR_URL ?? ''

/** Protomaps archives are read through the `pmtiles://` protocol, not fetched as a style. */
export function isPMTilesArchive(url: string): boolean {
  return url.trim().toLowerCase().endsWith('.pmtiles')
}

/**
 * Deepest zoom the whole-world companion archive has native tiles for.
 *
 * `pmtiles extract` keeps every zoom 0..maxzoom for any tile that *intersects*
 * the requested bbox, and at z4 one tile spans most of a continent — so a local
 * extract's low zooms hold a handful of giant part-filled tiles that render as
 * a rectangle of map floating in a void. Rather than clamp zoom-out (rejected:
 * it removes a view the operator legitimately wants), the style lays a second,
 * bboxless world extract underneath. A z6 whole planet is ~43 MB, which the Pi
 * can afford; z7 would quadruple it for detail the local extract already has.
 *
 * Must match `--maxzoom` for the world extract in scripts/fetch-basemap.sh.
 */
export const WORLD_MAX_ZOOM = 6

/**
 * Where the whole-world companion for a local archive lives: by convention,
 * `basemap.pmtiles` → `basemap-world.pmtiles` next to it. A convention rather
 * than a second env var so that dropping the file beside the extract is the
 * whole deployment story; the UI probes for it and degrades to the bare
 * extract if it is absent.
 */
export function worldArchiveUrlFor(archiveUrl: string): string {
  return `${archiveUrl.trim().slice(0, -'.pmtiles'.length)}-world.pmtiles`
}

const VECTOR_ATTRIBUTION =
  '<a href="https://protomaps.com" target="_blank">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'

interface Palette {
  background: string
  ring: string
  ringMajor: string
  spoke: string
  earth: string
  water: string
  green: string
  road: string
  roadMinor: string
  building: string
  boundary: string
}

// Basemap tones sit well clear of the background, which the first version of
// this palette did not.
//
// Every value here was within about #12-#2e against a #0d1117 background --
// technically drawn, effectively invisible, and completely gone once the
// coverage-broken scrim (a red hatch plus 60% backdrop-grayscale) went over the
// top. It read as "the tiles failed to load", which is the one thing a basemap
// must never look like: this display already uses an empty map to mean "nothing
// detected", so a blank one that actually means "styling too dark" is the same
// ambiguity the sky-state banner exists to remove.
//
// The raster style below records the identical mistake and its correction --
// "dim enough to read as 'no detail' rather than deliberately recessive". These
// are the same lesson applied to vector tiles. Still desaturated, so the
// saturated cyan and magenta of aircraft and operators stay dominant; the point
// is legible-but-quiet, not absent.
const DARK: Palette = {
  background: '#0d1117',
  ring: '#1e2a3d',
  ringMajor: '#2c3e59',
  spoke: '#1a2433',
  earth: '#1a222c',
  water: '#16324a',
  green: '#1b2a20',
  road: '#3d4a5c',
  roadMinor: '#2a3442',
  building: '#232c37',
  boundary: '#465569',
}

const LIGHT: Palette = {
  background: '#eef1f5',
  ring: '#cfd6e0',
  ringMajor: '#b3bdcc',
  spoke: '#dbe0e8',
  earth: '#e9edf2',
  water: '#d3e0ec',
  green: '#e0e9e0',
  road: '#ffffff',
  roadMinor: '#f4f6f9',
  building: '#dfe4ea',
  boundary: '#c2cad4',
}

export function palette(theme: 'dark' | 'light'): Palette {
  return theme === 'dark' ? DARK : LIGHT
}

/**
 * Concentric range rings + bearing spokes around `center`.
 * Radii are chosen from the current view span so the rings stay legible at any
 * zoom rather than collapsing into a dot or spilling off screen.
 */
export function rangeRings(
  center: [number, number],
  radiiMetres: number[],
): GeoJSON.FeatureCollection {
  const [lon, lat] = center
  const metresPerDegLat = 111_320
  const metresPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180) || 1
  const features: GeoJSON.Feature[] = []

  for (const [index, radius] of radiiMetres.entries()) {
    const coordinates: [number, number][] = []
    for (let deg = 0; deg <= 360; deg += 3) {
      const rad = (deg * Math.PI) / 180
      coordinates.push([
        lon + (Math.sin(rad) * radius) / metresPerDegLon,
        lat + (Math.cos(rad) * radius) / metresPerDegLat,
      ])
    }
    features.push({
      type: 'Feature',
      properties: { radius_m: radius, major: index === radiiMetres.length - 1 },
      geometry: { type: 'LineString', coordinates },
    })
  }

  const outer = radiiMetres[radiiMetres.length - 1] ?? 1000
  for (let deg = 0; deg < 360; deg += 45) {
    const rad = (deg * Math.PI) / 180
    features.push({
      type: 'Feature',
      properties: { bearing: deg, spoke: true },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon, lat],
          [
            lon + (Math.sin(rad) * outer) / metresPerDegLon,
            lat + (Math.cos(rad) * outer) / metresPerDegLat,
          ],
        ],
      },
    })
  }

  return { type: 'FeatureCollection', features }
}

/** Pick ring radii that fit the current view span (metres across the viewport). */
export function ringRadiiFor(spanMetres: number): number[] {
  const target = spanMetres / 2
  const steps = [50, 100, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000]
  const outer = steps.find((s) => s >= target) ?? steps[steps.length - 1] ?? 1000
  const index = steps.indexOf(outer)
  return steps.slice(Math.max(0, index - 2), index + 1)
}

/** Style with no basemap: background + range rings only. Needs no network. */
export function noTilesStyle(theme: 'dark' | 'light'): StyleSpecification {
  const p = palette(theme)
  return {
    version: 8,
    // No `glyphs` and no `sprite`: nothing here uses text-field or icons, so the
    // style is genuinely self-contained. Labels are DOM markers instead.
    sources: {
      rings: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
      {
        id: 'ring-spokes',
        type: 'line',
        source: 'rings',
        filter: ['==', ['get', 'spoke'], true],
        paint: { 'line-color': p.spoke, 'line-width': 1 },
      },
      {
        id: 'ring-circles',
        type: 'line',
        source: 'rings',
        filter: ['!=', ['get', 'spoke'], true],
        paint: {
          'line-color': ['case', ['get', 'major'], p.ringMajor, p.ring],
          'line-width': ['case', ['get', 'major'], 1.4, 1],
        },
      },
    ],
  }
}

/**
 * Style backed by a Protomaps `.pmtiles` archive.
 *
 * Hand-written rather than pulled from `protomaps-themes-base`, for two reasons
 * that both matter more than the fifty lines it costs:
 *
 * - **No glyphs, no sprite, no text.** Every label here would need a font stack
 *   fetched from somewhere, which is exactly the dependency the archive exists
 *   to remove. Place names are the one thing a basemap adds that this display
 *   does not want anyway — the aircraft carry their own DOM labels, and unread
 *   town names compete with them for the same pixels.
 * - **The palette is the point.** A general-purpose theme is designed to be
 *   looked at. This one is designed to be looked *past*: shapes for orientation,
 *   nothing saturated, so the cyan and magenta of the tracks stay the brightest
 *   thing on screen. Same reasoning as the raster style's opacity knock-back.
 *
 * Layer names are the Protomaps basemap v4 schema.
 *
 * When `worldArchiveUrl` is given, a second source — the bboxless z0–6 world
 * extract, see WORLD_MAX_ZOOM — is drawn *underneath* the local layers, so
 * zooming out shows real geography instead of the extract's floating
 * rectangle. Three properties keep the seam invisible:
 *
 * - Both archives come from the same planet build, so wherever both have a
 *   native tile for the same zoom the geometry is identical and the overdraw
 *   changes nothing.
 * - World earth/water run at every zoom (overzoomed past z6), filling the void
 *   around the extract at mid zooms too; the local opaque fills simply paint
 *   over them inside coverage.
 * - World lines (roads, boundaries) stop at z7. Past that they would be
 *   overzoomed and visibly offset from the local archive's native geometry —
 *   a ghost road beside every real one.
 */
export function vectorStyle(
  theme: 'dark' | 'light',
  archiveUrl: string,
  worldArchiveUrl?: string | null,
): StyleSpecification {
  const p = palette(theme)
  // Shared between the local and world landuse layers: with different kind
  // lists the two sources would render different greens for the same ground,
  // and the extract's edge would show as a tone change instead of nothing.
  const landuseKinds = [
    'park',
    'forest',
    'wood',
    'grass',
    'grassland',
    'meadow',
    'scrub',
    'garden',
    'farmland',
    'nature_reserve',
    'recreation_ground',
    'golf_course',
    'cemetery',
    'wetland',
  ]
  const worldSource: StyleSpecification['sources'] = worldArchiveUrl
    ? {
        'protomaps-world': {
          type: 'vector',
          url: `pmtiles://${worldArchiveUrl}`,
          attribution: VECTOR_ATTRIBUTION,
        },
      }
    : {}
  const worldLayers: StyleSpecification['layers'] = worldArchiveUrl
    ? [
        {
          id: 'world-earth',
          type: 'fill',
          source: 'protomaps-world',
          'source-layer': 'earth',
          paint: { 'fill-color': p.earth },
        },
        {
          id: 'world-landuse',
          type: 'fill',
          source: 'protomaps-world',
          'source-layer': 'landuse',
          filter: ['in', ['get', 'kind'], ['literal', landuseKinds]],
          paint: { 'fill-color': p.green },
        },
        {
          id: 'world-water',
          type: 'fill',
          source: 'protomaps-world',
          'source-layer': 'water',
          paint: { 'fill-color': p.water },
        },
        {
          id: 'world-roads-major',
          type: 'line',
          source: 'protomaps-world',
          'source-layer': 'roads',
          filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
          maxzoom: WORLD_MAX_ZOOM + 1,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': p.road,
            'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.5, 18, 6],
          },
        },
        {
          id: 'world-boundaries',
          type: 'line',
          source: 'protomaps-world',
          'source-layer': 'boundaries',
          maxzoom: WORLD_MAX_ZOOM + 1,
          paint: { 'line-color': p.boundary, 'line-width': 0.8, 'line-dasharray': [3, 2] },
        },
      ]
    : []
  return {
    version: 8,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${archiveUrl}`,
        attribution: VECTOR_ATTRIBUTION,
      },
      ...worldSource,
      rings: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
      ...worldLayers,
      {
        id: 'earth',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'earth',
        paint: { 'fill-color': p.earth },
      },
      {
        id: 'landuse',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'landuse',
        // Kinds surveyed from a real extract rather than guessed — see the
        // note on the road layers below.
        filter: ['in', ['get', 'kind'], ['literal', landuseKinds]],
        paint: { 'fill-color': p.green },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'water',
        paint: { 'fill-color': p.water },
      },
      {
        id: 'buildings',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'buildings',
        // Below z14 buildings are a grey wash that reads as fog, not as a city.
        minzoom: 14,
        paint: { 'fill-color': p.building, 'fill-opacity': 0.85 },
      },
      // Road `kind` is an enum, not a hierarchy, and the values below were read
      // out of a real extract (scripts/fetch-basemap.sh, then `go-pmtiles tile`
      // decoded) rather than assumed. Two things a plausible-looking filter got
      // wrong before that survey:
      //
      //   - `major_road` is its own kind, so `kind == 'highway'` for the major
      //     layer drew every arterial as a hairline residential street.
      //   - the minor layer was `kind != 'highway'`, which is also true of
      //     `ferry`, `rail`, `path` and `aeroway` — so ferry routes were drawn
      //     as roads across open water, and runways as streets.
      //
      // Both layers therefore name their kinds explicitly. Anything unlisted is
      // not drawn, which is the safe direction: a missing road is a smaller lie
      // than a road that is not there.
      {
        id: 'roads-minor',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['medium_road', 'minor_road']]],
        minzoom: 11,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.roadMinor,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0.4, 18, 4],
        },
      },
      {
        id: 'roads-major',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.road,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.5, 18, 6],
        },
      },
      {
        id: 'boundaries',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'boundaries',
        paint: { 'line-color': p.boundary, 'line-width': 0.8, 'line-dasharray': [3, 2] },
      },
      {
        id: 'ring-spokes',
        type: 'line',
        source: 'rings',
        filter: ['==', ['get', 'spoke'], true],
        paint: { 'line-color': p.spoke, 'line-width': 1, 'line-opacity': 0.6 },
      },
      {
        id: 'ring-circles',
        type: 'line',
        source: 'rings',
        filter: ['!=', ['get', 'spoke'], true],
        paint: {
          'line-color': ['case', ['get', 'major'], p.ringMajor, p.ring],
          'line-width': ['case', ['get', 'major'], 1.4, 1],
          'line-opacity': 0.7,
        },
      },
    ],
  }
}

/** Style backed by self-hosted raster tiles. */
export function tiledStyle(theme: 'dark' | 'light', baseUrl: string): StyleSpecification {
  const p = palette(theme)
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [`${baseUrl}${TILE_PATH}`],
        tileSize: 256,
        minzoom: 0,
        maxzoom: BASEMAP_MAX_ZOOM,
        attribution: BASEMAP_ATTRIBUTION,
      },
      rings: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        paint: {
          // Knock the basemap back so aircraft stay the brightest thing on
          // screen, and desaturate it in dark mode without a second tile set.
          //
          // Eased from 0.55/-0.6/0.75: combined with a z15 ceiling the imagery
          // was dim enough to read as "no detail" rather than "deliberately
          // recessive". Aircraft and tracks are drawn in saturated cyan and
          // magenta, so they still dominate at these values.
          'raster-opacity': theme === 'dark' ? 0.7 : 0.95,
          'raster-saturation': theme === 'dark' ? -0.4 : 0,
          'raster-brightness-max': theme === 'dark' ? 0.9 : 1,
        },
      },
      {
        id: 'ring-spokes',
        type: 'line',
        source: 'rings',
        filter: ['==', ['get', 'spoke'], true],
        paint: { 'line-color': p.spoke, 'line-width': 1, 'line-opacity': 0.5 },
      },
      {
        id: 'ring-circles',
        type: 'line',
        source: 'rings',
        filter: ['!=', ['get', 'spoke'], true],
        paint: { 'line-color': p.ring, 'line-width': 1, 'line-opacity': 0.6 },
      },
    ],
  }
}

/**
 * Is the configured vector source actually there?
 *
 * Same reason the raster probe exists — a missing basemap is silent in MapLibre
 * — plus one specific to a file served out of `public/`: an SPA server answers
 * an unknown path with `index.html` and a 200, so a deleted archive would look
 * present and then fail as an unreadable style. For an archive the probe reads
 * the first bytes and checks the PMTiles magic, which is the only answer that
 * cannot be faked by an HTML fallback.
 */
export async function vectorReachable(url: string, signal?: AbortSignal): Promise<boolean> {
  if (!url.trim()) return false
  try {
    const archive = isPMTilesArchive(url)
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      ...(archive ? { headers: { Range: 'bytes=0-6' } } : {}),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) return false
    if (!archive) return true
    const magic = new Uint8Array(await response.arrayBuffer())
    return String.fromCharCode(...magic.slice(0, 7)) === 'PMTiles'
  } catch {
    return false
  }
}

/**
 * Is a tile server actually reachable? MapLibre treats tile 404s as non-fatal and
 * silent, so a probe is the only way to know before choosing a style.
 */
export async function tilesReachable(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}tiles/basemap/0/0/0.jpg`, {
      method: 'GET',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    })
    // The SPA server may answer an unknown tile path with index.html and a 200.
    // Treat only image responses as tiles, otherwise MapLibre repeatedly tries
    // to decode the HTML fallback as PNG data and floods the console.
    return (
      response.ok &&
      response.headers.get('x-classg-basemap') !== 'offline fallback' &&
      (response.headers.get('content-type')?.startsWith('image/') ?? false)
    )
  } catch {
    return false
  }
}

/**
 * Map styles.
 *
 * A field-deployed Pi has no internet. MapLibre was chosen precisely so tiles can
 * be self-hosted, but the honest default is that there may be no tiles at all —
 * so there are two styles here and the app picks between them by probing.
 *
 * The no-tile style is deliberately not a blank void: it draws range rings and
 * bearing spokes around the view centre, which gives distance and bearing sense
 * without any basemap. A drone 400 m out on a bearing of 310 is still readable.
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
 * (46.0400, -122.7673):
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

export type BasemapMode = 'tiles' | 'no-tiles'

interface Palette {
  background: string
  ring: string
  ringMajor: string
  spoke: string
}

const DARK: Palette = {
  background: '#0d1117',
  ring: '#1e2a3d',
  ringMajor: '#2c3e59',
  spoke: '#1a2433',
}

const LIGHT: Palette = {
  background: '#eef1f5',
  ring: '#cfd6e0',
  ringMajor: '#b3bdcc',
  spoke: '#dbe0e8',
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

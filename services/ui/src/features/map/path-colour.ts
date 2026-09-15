/**
 * The detail map's coloured route.
 *
 * The live map draws one hue whose WIDTH follows confidence and never its hue
 * ("Never a hue ramp" in live-map.tsx) — on a screen watching for aircraft,
 * colour has to mean identity, and a second meaning for it would make the
 * display ambiguous at exactly the wrong moment. A track's detail page is not
 * that screen: there is one aircraft, the flight is over, and the question has
 * changed from "what is out there" to "what did this one do". So the route is
 * shaded here, and only here.
 *
 * It is a SEQUENTIAL ramp on one hue, dim/low-chroma for slow to full `--track`
 * for fast — not a rainbow. The reasons are the standard ones: a hue ramp has
 * no inherent order, so the reader has to consult the legend for every segment,
 * and it falls apart under the two commonest colour-vision deficiencies. A
 * single hue's lightness ordering survives both, and survives a phone in
 * daylight. Lightness runs light-to-dark in the light theme and dark-to-light
 * in the dark one, because the anchor is the page, not the colour.
 *
 * Geometry is one LineString per pair of points rather than a `line-gradient`
 * on a `lineMetrics` source. Two reasons: `line-gradient` measures along the
 * line's own length, so a slow segment covering two metres and a fast one
 * covering two hundred would get equal shares of the ramp; and it cannot
 * coexist with the dashed reception-gap segments, which have to stay.
 */
import type { Position } from '@/lib/api/types'
import {
  dwellPoints,
  pathSegments,
  speedExtent,
  timeExtent,
  type Extent,
} from '@/features/tracks/flight-speed'

export const PATH_COLOUR_MODES = ['speed', 'time', 'none'] as const
export type PathColourMode = (typeof PATH_COLOUR_MODES)[number]

export const PATH_COLOUR_LABELS: Record<PathColourMode, string> = {
  speed: 'Speed',
  time: 'Time',
  none: 'None',
}

export interface ColouredPath {
  mode: PathColourMode
  /**
   * One LineString per segment. Properties:
   *   `gap`   — reception was lost across it; drawn dashed, never shaded.
   *   `known` — the ramp's value is a measurement, not an absence.
   *   `value` — 0..1 within `extent`, so the paint expression is the same
   *             whatever the mode and whatever the flight's range.
   */
  segments: GeoJSON.FeatureCollection
  /** Hover/dwell dots, `seconds` driving the radius. Empty unless mode is speed. */
  dwells: GeoJSON.FeatureCollection
  /** Domain the ramp spans, in m/s for speed and epoch ms for time. Null when nothing was measured. */
  extent: Extent | null
  /** How many segments carry no measurement, so the legend can admit it. */
  unknownSegments: number
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Normalise into the ramp.
 *
 * A zero-width extent maps everything to the TOP of the ramp rather than the
 * bottom. A flight flown at a constant 6 m/s is not a flight of slow segments;
 * painting it in the dim end would read as "barely moving" when the legend
 * says 6 m/s throughout.
 */
function normalise(value: number, extent: Extent): number {
  const span = extent.max - extent.min
  if (span <= 0) return 1
  return Math.min(1, Math.max(0, (value - extent.min) / span))
}

export function colouredPath(path: Position[], mode: PathColourMode): ColouredPath {
  const segments = pathSegments(path)
  if (segments.length === 0) {
    return { mode, segments: EMPTY, dwells: EMPTY, extent: null, unknownSegments: 0 }
  }

  const extent =
    mode === 'speed' ? speedExtent(segments) : mode === 'time' ? timeExtent(path) : null

  let unknownSegments = 0
  const features: GeoJSON.Feature[] = segments.map((segment, index) => {
    const raw = mode === 'speed' ? segment.speedMps : mode === 'time' ? segment.midMs : null
    // One expression for both, so `known` cannot claim a value the paint
    // expression does not actually have.
    const value =
      !segment.gap && extent !== null && raw !== null ? normalise(raw, extent) : null
    if (mode !== 'none' && !segment.gap && value === null) unknownSegments += 1
    return {
      type: 'Feature',
      id: index,
      properties: {
        gap: segment.gap,
        known: value !== null,
        value: value ?? 0,
        // Read back by the map's hover readout; kept in the source units so
        // nothing has to un-normalise a 0..1 to show a number.
        speed_mps: segment.speedMps,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [segment.from.lon, segment.from.lat],
          [segment.to.lon, segment.to.lat],
        ],
      },
    }
  })

  // Only under the speed ramp. A dwell IS a speed reading — the dots and the
  // shading are two views of one measurement — and showing them beside a time
  // ramp would put an unexplained second encoding on the map.
  const dwells: GeoJSON.Feature[] =
    mode === 'speed'
      ? dwellPoints(path).map((dwell, index) => ({
          type: 'Feature',
          id: index,
          properties: { seconds: dwell.seconds, start_ms: dwell.startMs },
          geometry: { type: 'Point', coordinates: [dwell.lon, dwell.lat] },
        }))
      : []

  return {
    mode,
    segments: { type: 'FeatureCollection', features },
    dwells: { type: 'FeatureCollection', features: dwells },
    extent,
    unknownSegments,
  }
}

/**
 * Five steps from the dim end of the track hue to its full value.
 *
 * Built with `color-mix(in oklch, …)` on the two tokens rather than as fixed
 * literals so the ramp follows `--track` and `--track-dim` when either is
 * retuned — the same reason `resolveTokenColor` exists in live-map.tsx. Mixing
 * in oklch rather than sRGB keeps the lightness steps even, which is the only
 * property a sequential ramp has to have.
 *
 * Five steps, not two: MapLibre would happily interpolate between two
 * endpoints, but it interpolates in sRGB, and an oklch pair sampled at five
 * points and joined by short sRGB runs is materially closer to the even ramp
 * than one long one.
 */
export const RAMP_STEPS = 5

export function rampMixExpressions(dimToken: string, brightToken: string): string[] {
  const steps: string[] = []
  for (let i = 0; i < RAMP_STEPS; i += 1) {
    const percent = Math.round((i / (RAMP_STEPS - 1)) * 100)
    steps.push(`color-mix(in oklch, ${brightToken} ${percent}%, ${dimToken})`)
  }
  return steps
}

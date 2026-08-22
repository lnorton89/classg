/**
 * Where a position's AGL came from.
 *
 * `height_agl_m` alone does not say whether the aircraft broadcast that height
 * or whether fusion worked it out by subtracting a terrain model from the
 * geodetic altitude. `terrain_elevation_m` is the marker that settles it: the
 * schema defines it as present ONLY on a derived height, so its absence
 * alongside an AGL means the aircraft reported the number itself.
 *
 * The two are not interchangeable readings. A broadcast AGL is the aircraft's
 * own measurement; a derived one is a subtraction against a model whose ground
 * may be a metre or thirty out. Rendering them identically claims a certainty
 * the second one does not have, so every surface that shows an AGL has to say
 * which it is looking at.
 */
import type { Position } from '@/lib/api/types'

export interface HeightProvenance {
  source: 'derived' | 'broadcast'
  /**
   * Ground elevation that was subtracted to get the AGL. Non-null exactly when
   * `source` is 'derived'.
   */
  terrainElevationM: number | null
}

/** Marks a derived AGL in a dense table, where a hint line does not fit. */
export const DERIVED_MARK = '†'

/**
 * Null when there is no AGL to attribute — an absent height needs no
 * provenance, and claiming one for it would be the same overstatement in the
 * other direction.
 */
export function heightProvenance(
  position: Pick<Position, 'height_agl_m' | 'terrain_elevation_m'> | null | undefined,
): HeightProvenance | null {
  if (position?.height_agl_m == null) return null
  const terrain = position.terrain_elevation_m
  return terrain == null
    ? { source: 'broadcast', terrainElevationM: null }
    : { source: 'derived', terrainElevationM: terrain }
}

/**
 * One short line naming the source. Takes the formatter rather than a number so
 * the ground elevation follows the operator's unit preference like every other
 * length on the page.
 */
export function heightProvenanceHint(
  provenance: HeightProvenance,
  length: (metres: number | null | undefined) => string,
): string {
  return provenance.source === 'derived'
    ? `derived — terrain ${length(provenance.terrainElevationM)}`
    : 'as broadcast'
}

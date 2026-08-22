import { describe, expect, it } from 'vitest'

import type { Position } from '@/lib/api/types'

import { heightProvenance, heightProvenanceHint } from './height-provenance'

function position(fields: Partial<Position> = {}): Position {
  return { lat: 47.3769, lon: 8.5417, ...fields }
}

/** Stand-in for useFormat().length, metric and terse. */
const metres = (m: number | null | undefined) => (m == null ? '—' : `${m} m`)

describe('heightProvenance', () => {
  it('reads terrain_elevation_m as the derived marker', () => {
    expect(heightProvenance(position({ height_agl_m: 42, terrain_elevation_m: 25 }))).toEqual({
      source: 'derived',
      terrainElevationM: 25,
    })
  })

  it('treats an AGL with no terrain elevation as the aircraft broadcasting it', () => {
    expect(heightProvenance(position({ height_agl_m: 42 }))).toEqual({
      source: 'broadcast',
      terrainElevationM: null,
    })
  })

  it('does not distinguish an explicit null terrain elevation from an absent one', () => {
    // The Go side omits the field; the generated type still admits null, and a
    // null there is an absence rather than a ground at sea level.
    expect(heightProvenance(position({ height_agl_m: 42, terrain_elevation_m: null }))).toEqual(
      {
        source: 'broadcast',
        terrainElevationM: null,
      },
    )
  })

  it('attributes nothing when there is no height to attribute', () => {
    expect(heightProvenance(position())).toBeNull()
    expect(heightProvenance(position({ height_agl_m: null }))).toBeNull()
    expect(heightProvenance(null)).toBeNull()
    expect(heightProvenance(undefined)).toBeNull()
  })

  it('reports a ground-level derivation rather than dropping it', () => {
    // 0 m of terrain is a real derivation over the sea, and a falsy check here
    // would have relabelled it as broadcast.
    expect(heightProvenance(position({ height_agl_m: 42, terrain_elevation_m: 0 }))).toEqual({
      source: 'derived',
      terrainElevationM: 0,
    })
  })
})

describe('heightProvenanceHint', () => {
  it('names the terrain the derivation used', () => {
    expect(heightProvenanceHint({ source: 'derived', terrainElevationM: 25 }, metres)).toBe(
      'derived — terrain 25 m',
    )
  })

  it('says a broadcast height came from the aircraft', () => {
    expect(heightProvenanceHint({ source: 'broadcast', terrainElevationM: null }, metres)).toBe(
      'as broadcast',
    )
  })
})

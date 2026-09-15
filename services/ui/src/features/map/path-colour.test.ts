/**
 * What the map is handed for the shaded route.
 *
 * The properties here are what the paint expression reads, so a mistake is not
 * a crash — it is a route drawn in a confident colour that means nothing.
 */
import { describe, expect, it } from 'vitest'

import type { Position } from '@/lib/api/types'

import { colouredPath, rampMixExpressions, RAMP_STEPS } from './path-colour'

const T0 = Date.parse('2026-09-14T23:16:58.000Z')

function at(seconds: number, speed?: number | null): Position {
  return {
    lat: 51.5 + seconds / 10_000,
    lon: -0.1,
    speed_mps: speed ?? null,
    at: new Date(T0 + seconds * 1000).toISOString(),
  }
}

function props(collection: GeoJSON.FeatureCollection, index: number) {
  return collection.features[index]?.properties ?? {}
}

describe('colouredPath', () => {
  it('emits one feature per segment, not one per point', () => {
    const coloured = colouredPath([at(0, 1), at(1, 2), at(2, 3)], 'speed')
    expect(coloured.segments.features).toHaveLength(2)
  })

  it('normalises each segment into the flight own range', () => {
    const coloured = colouredPath([at(0, 0), at(1, 0), at(2, 10), at(3, 10)], 'speed')
    // Segment speeds are 0, 5, 10 -> 0, 0.5, 1.
    expect(props(coloured.segments, 0).value).toBeCloseTo(0, 6)
    expect(props(coloured.segments, 1).value).toBeCloseTo(0.5, 6)
    expect(props(coloured.segments, 2).value).toBeCloseTo(1, 6)
    expect(coloured.extent).toEqual({ min: 0, max: 10 })
  })

  it('paints a constant-speed flight at the TOP of the ramp, not the bottom', () => {
    // 6 m/s throughout is not a flight of slow legs. Painting it dim would
    // read as "barely moving" while the legend says 6 m/s.
    const coloured = colouredPath([at(0, 6), at(1, 6), at(2, 6)], 'speed')
    expect(props(coloured.segments, 0).value).toBe(1)
    expect(props(coloured.segments, 0).known).toBe(true)
  })

  it('marks a reception gap unshaded and counts it as neither known nor unknown', () => {
    const coloured = colouredPath([at(0, 4), at(120, 4)], 'speed')
    expect(props(coloured.segments, 0).gap).toBe(true)
    expect(props(coloured.segments, 0).known).toBe(false)
    // A gap is not a segment whose speed went unreported; it is an interval
    // nothing measured, and the legend already names it separately.
    expect(coloured.unknownSegments).toBe(0)
  })

  it('counts segments that reported no speed so the legend can admit them', () => {
    const coloured = colouredPath([at(0), at(1), at(2)], 'speed')
    expect(coloured.extent).toBeNull()
    expect(coloured.unknownSegments).toBe(2)
    expect(props(coloured.segments, 0).known).toBe(false)
  })

  it('ramps by time when asked, over the same segments', () => {
    const coloured = colouredPath([at(0, 1), at(10, 1), at(20, 1)], 'time')
    expect(coloured.segments.features).toHaveLength(2)
    expect(props(coloured.segments, 0).value).toBeLessThan(
      Number(props(coloured.segments, 1).value),
    )
  })

  it('shades nothing and finds no hovers in "none" mode', () => {
    const coloured = colouredPath([at(0, 0.1), at(30, 0.1)], 'none')
    expect(coloured.extent).toBeNull()
    expect(props(coloured.segments, 0).known).toBe(false)
    expect(coloured.dwells.features).toHaveLength(0)
  })

  it('carries hovers only under the speed ramp', () => {
    const hovering: Position[] = []
    for (let s = 0; s <= 20; s += 1) hovering.push(at(s, 0.1))
    expect(colouredPath(hovering, 'speed').dwells.features).toHaveLength(1)
    // Two encodings of two different things on one map would need two legends.
    expect(colouredPath(hovering, 'time').dwells.features).toHaveLength(0)
  })

  it('draws nothing at all for a single fix', () => {
    const coloured = colouredPath([at(0, 3)], 'speed')
    expect(coloured.segments.features).toHaveLength(0)
    expect(coloured.dwells.features).toHaveLength(0)
  })
})

describe('rampMixExpressions', () => {
  it('runs from the dim end to the bright one in even steps', () => {
    const steps = rampMixExpressions('var(--track-dim)', 'var(--track)')
    expect(steps).toHaveLength(RAMP_STEPS)
    expect(steps[0]).toContain('var(--track) 0%')
    expect(steps[steps.length - 1]).toContain('var(--track) 100%')
    // oklch, not sRGB: an even lightness ramp is the one property a
    // sequential scale has to have.
    expect(steps.every((step) => step.startsWith('color-mix(in oklch,'))).toBe(true)
  })
})

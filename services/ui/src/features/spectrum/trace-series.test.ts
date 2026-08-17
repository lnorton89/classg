import { describe, expect, it } from 'vitest'

import type { SpectrumTrace } from '@/lib/api/types'

import {
  blindPercent,
  cellHz,
  formatMHz,
  fractionAtHz,
  hzAtFraction,
  nearestCell,
  plotRange,
  traceExtent,
  traceSegments,
} from './trace-series'

function trace(dbfs: (number | null)[], overrides: Partial<SpectrumTrace> = {}): SpectrumTrace {
  return {
    start_hz: 902_000_000,
    stop_hz: 902_000_000 + dbfs.length * 1000,
    bin_width_hz: 1000,
    dbfs,
    blind: dbfs.filter((v) => v === null).length,
    ...overrides,
  }
}

describe('traceSegments', () => {
  it('breaks the line at a null rather than joining across it', () => {
    const segments = traceSegments(trace([-70, -71, null, -69, -68]))

    expect(segments).toHaveLength(2)
    expect(segments[0]?.map((p) => p.db)).toEqual([-70, -71])
    expect(segments[1]?.map((p) => p.db)).toEqual([-69, -68])
  })

  it('never emits a point for an unmeasured cell', () => {
    // The whole point: a DC guard must not become a level. If it did, every
    // step centre would show the receiver's own oscillator as a signal.
    const segments = traceSegments(trace([-70, null, null, null, -70]))
    const all = segments.flat()

    expect(all).toHaveLength(2)
    expect(all.every((p) => Number.isFinite(p.db))).toBe(true)
  })

  it('keeps a lone reading between two gaps', () => {
    // One cell between two notches is still a measurement, and it may be the
    // only evidence at that frequency.
    const segments = traceSegments(trace([null, -55, null]))

    expect(segments).toHaveLength(1)
    expect(segments[0]).toHaveLength(1)
    expect(segments[0]?.[0]?.db).toBe(-55)
  })

  it('maps each point to its own centre frequency', () => {
    const t = trace([-70, -71, -72])
    const points = traceSegments(t).flat()

    expect(points[0]?.hz).toBe(902_000_500)
    expect(points[2]?.hz).toBe(902_002_500)
    expect(points.map((p) => p.hz)).toEqual([0, 1, 2].map((i) => cellHz(t, i)))
  })

  it('returns nothing for a trace that is missing or empty', () => {
    expect(traceSegments(undefined)).toEqual([])
    expect(traceSegments(trace([]))).toEqual([])
  })

  it('treats a non-finite value as a gap, not a level', () => {
    expect(traceSegments(trace([-70, Number.NaN, -70])).length).toBe(2)
  })
})

describe('traceExtent', () => {
  it('spans every segment, not just the first', () => {
    expect(traceExtent(traceSegments(trace([-70, null, -45])))).toEqual({
      min: -70,
      max: -45,
    })
  })

  it('is null when nothing was measured', () => {
    expect(traceExtent(traceSegments(trace([null, null])))).toBeNull()
  })
})

describe('plotRange', () => {
  it('always includes the threshold, so an empty band reads as headroom', () => {
    // The common case: a quiet band whose trace sits well below the threshold.
    // If the threshold fell off the top the chart would look full rather than
    // showing that nothing cleared it.
    const range = plotRange({ min: -80, max: -70 }, -75, -60)

    expect(range.min).toBeLessThan(-80)
    expect(range.max).toBeGreaterThan(-60)
  })

  it('survives a floor and threshold that were never measured', () => {
    const range = plotRange({ min: -80, max: -70 }, null, undefined)

    expect(range.min).toBeLessThan(-80)
    expect(range.max).toBeGreaterThan(-70)
    expect(Number.isFinite(range.min) && Number.isFinite(range.max)).toBe(true)
  })

  it('gives a flat band a finite height instead of dividing by zero', () => {
    const range = plotRange({ min: -70, max: -70 }, null, null)

    expect(range.max - range.min).toBeGreaterThan(0)
    expect(Number.isFinite(range.max - range.min)).toBe(true)
  })

  it('has a drawable range even with nothing measured at all', () => {
    const range = plotRange(null, null, null)

    expect(range.max).toBeGreaterThan(range.min)
  })
})

describe('nearestCell', () => {
  it('returns the cell under a frequency', () => {
    const t = trace([-70, -71, -72])

    expect(nearestCell(t, 902_000_500)).toBe(0)
    expect(nearestCell(t, 902_002_400)).toBe(2)
  })

  it('returns the index of an unmeasured cell rather than skipping to a reading', () => {
    // Hovering a notch must be able to say "unmeasured here". Snapping to the
    // nearest measured cell would label a reading with the cursor's frequency,
    // which is a signal reported at a frequency it was not seen at.
    const t = trace([-70, null, -72])

    expect(nearestCell(t, 902_001_500)).toBe(1)
  })

  it('is null outside the trace', () => {
    const t = trace([-70, -71])

    expect(nearestCell(t, 800_000_000)).toBeNull()
    expect(nearestCell(t, 999_000_000)).toBeNull()
    expect(nearestCell(undefined, 902_000_000)).toBeNull()
  })
})

describe('frequency mapping', () => {
  it('round-trips a fraction through a frequency', () => {
    const t = trace([-70, -71, -72, -73])

    expect(fractionAtHz(t, hzAtFraction(t, 0.25))).toBeCloseTo(0.25, 10)
    expect(fractionAtHz(t, hzAtFraction(t, 0))).toBe(0)
    expect(fractionAtHz(t, hzAtFraction(t, 1))).toBe(1)
  })

  it('clamps a frequency outside the band', () => {
    const t = trace([-70, -71])

    expect(fractionAtHz(t, 0)).toBe(0)
    expect(fractionAtHz(t, 999_000_000_000)).toBe(1)
  })
})

describe('blindPercent', () => {
  it('reports the share of the band that was not measured', () => {
    expect(blindPercent(trace([-70, null, -70, null]))).toBe(50)
    expect(blindPercent(trace([-70, -70]))).toBe(0)
    expect(blindPercent(undefined)).toBe(0)
  })
})

describe('formatMHz', () => {
  it('reads in MHz to kHz precision', () => {
    expect(formatMHz(902_341_000)).toBe('902.341 MHz')
  })
})

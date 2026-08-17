import { describe, expect, it } from 'vitest'

import {
  downsampleSegment,
  nearestSampleIndex,
  sampleCadenceMs,
  seriesExtent,
  splitSegments,
  type TelemetryPoint,
} from './telemetry-series'
import type { TelemetrySample } from '@/lib/api/types'

/** Minute-spaced samples whose cpu_temp_c takes the given values in order. */
function samplesOf(values: (number | null)[], startMs = Date.parse('2026-08-17T18:00:00Z')) {
  return values.map((value, i): TelemetrySample => ({
    ts: new Date(startMs + i * 60_000).toISOString(),
    cpu_temp_c: value,
    load1: 0.5,
    mem_available_kb: 1,
    disk_free_bytes: 1,
    uptime_s: i * 60,
  }))
}

const pickCpu = (s: TelemetrySample) => s.cpu_temp_c

describe('splitSegments', () => {
  // THE rule. null means "the api could not read it", and the line must break:
  // a point at zero or a line across the hole is fabricated data in the same
  // ink as measurements.
  it('breaks the line at a null reading instead of drawing through it', () => {
    const segments = splitSegments(samplesOf([44, 45, null, 46, 47]), pickCpu)

    expect(segments).toHaveLength(2)
    expect(segments[0]?.map((p) => p.v)).toEqual([44, 45])
    expect(segments[1]?.map((p) => p.v)).toEqual([46, 47])
  })

  it('never emits any point for a null — not zero, not an interpolation', () => {
    const segments = splitSegments(samplesOf([44, null, 46]), pickCpu)

    const emitted = segments.flat()
    expect(emitted).toHaveLength(2)
    expect(emitted.map((p) => p.v)).toEqual([44, 46])
    // No fabricated zero anywhere, and nothing at the null sample's timestamp.
    expect(emitted.some((p) => p.v === 0)).toBe(false)
    const nullTs = Date.parse('2026-08-17T18:01:00Z')
    expect(emitted.some((p) => p.t === nullTs)).toBe(false)
  })

  it('keeps a genuine zero as a value — an idle Pi really reports load 0', () => {
    const segments = splitSegments(samplesOf([1, 0, 2]), pickCpu)

    expect(segments).toHaveLength(1)
    expect(segments[0]?.map((p) => p.v)).toEqual([1, 0, 2])
  })

  it('breaks the line where sample rows are missing entirely', () => {
    // The sampler itself was down: rows vanish rather than carrying nulls.
    // A line across that hole makes the same false claim a null-crossing does.
    const start = Date.parse('2026-08-17T18:00:00Z')
    const run = (offsetMinutes: number, values: number[]) =>
      values.map((value, i): TelemetrySample => ({
        ts: new Date(start + (offsetMinutes + i) * 60_000).toISOString(),
        cpu_temp_c: value,
        load1: null,
        mem_available_kb: null,
        disk_free_bytes: null,
        uptime_s: null,
      }))
    const segments = splitSegments([...run(0, [44, 45, 44]), ...run(30, [46, 47, 46])], pickCpu)

    expect(segments).toHaveLength(2)
  })

  it('keeps a lone reading between gaps as a single-point segment', () => {
    const segments = splitSegments(samplesOf([null, 45, null]), pickCpu)

    expect(segments).toHaveLength(1)
    expect(segments[0]).toHaveLength(1)
    expect(segments[0]?.[0]?.v).toBe(45)
  })

  it('returns no segments when every reading in the window is null', () => {
    expect(splitSegments(samplesOf([null, null, null]), pickCpu)).toEqual([])
  })
})

describe('seriesExtent', () => {
  it('spans all segments and is null when there are none', () => {
    const segments = splitSegments(samplesOf([44, null, 48, 42]), pickCpu)
    expect(seriesExtent(segments)).toEqual({ min: 42, max: 48 })
    expect(seriesExtent([])).toBeNull()
  })
})

describe('sampleCadenceMs', () => {
  it('measures the one-a-minute cadence from the rows', () => {
    expect(sampleCadenceMs(samplesOf([1, 2, 3, 4]))).toBe(60_000)
  })

  it('falls back to the nominal cadence with too few rows', () => {
    expect(sampleCadenceMs(samplesOf([1]))).toBe(60_000)
    expect(sampleCadenceMs([])).toBe(60_000)
  })
})

describe('downsampleSegment', () => {
  const points = (n: number): TelemetryPoint[] =>
    Array.from({ length: n }, (_, i) => ({ t: i * 60_000, v: Math.sin(i / 5) * 10 }))

  it('leaves short segments untouched', () => {
    const input = points(100)
    expect(downsampleSegment(input, 700)).toEqual(input)
  })

  it('thins long segments but keeps the extremes', () => {
    const input = points(5000)
    const out = downsampleSegment(input, 700)
    expect(out.length).toBeLessThanOrEqual(700)
    const inExtent = {
      min: Math.min(...input.map((p) => p.v)),
      max: Math.max(...input.map((p) => p.v)),
    }
    const outExtent = {
      min: Math.min(...out.map((p) => p.v)),
      max: Math.max(...out.map((p) => p.v)),
    }
    expect(outExtent).toEqual(inExtent)
    // Still in time order, so the path never doubles back.
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]
      const curr = out[i]
      expect(prev).toBeDefined()
      expect(curr).toBeDefined()
      if (prev && curr) expect(curr.t).toBeGreaterThanOrEqual(prev.t)
    }
  })
})

describe('nearestSampleIndex', () => {
  it('snaps to the closest row, including rows whose reading is null', () => {
    const samples = samplesOf([44, null, 46])
    const t0 = Date.parse('2026-08-17T18:00:00Z')
    expect(nearestSampleIndex(samples, t0)).toBe(0)
    // 55 s in: nearest row is the null one — the hover readout must land on it
    // and say "Unavailable", not skip to a neighbour's real value.
    expect(nearestSampleIndex(samples, t0 + 55_000)).toBe(1)
    expect(nearestSampleIndex(samples, t0 + 10 * 60_000)).toBe(2)
    expect(nearestSampleIndex([], t0)).toBeNull()
  })
})

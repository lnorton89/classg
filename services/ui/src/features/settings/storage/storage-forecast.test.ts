import { describe, expect, it } from 'vitest'

import { forecastDiskFull, usedFraction } from './storage-forecast'
import type { FreeSpacePoint } from './storage-forecast'

const T0 = Date.parse('2026-08-11T00:00:00.000Z')
const MINUTE = 60_000
const GB = 1_000_000_000

/** `count` samples a minute apart, free space moving by `perDay` bytes/day. */
function series(count: number, startFree: number, perDay: number): FreeSpacePoint[] {
  return Array.from({ length: count }, (_unused, i) => ({
    ts: T0 + i * MINUTE,
    free: startFree + (perDay * (i * MINUTE)) / 86_400_000,
  }))
}

describe('forecastDiskFull', () => {
  it('reports days remaining when free space is falling steadily', () => {
    const verdict = forecastDiskFull(series(240, 100 * GB, -10 * GB))
    expect(verdict.kind).toBe('filling')
    if (verdict.kind !== 'filling') return
    expect(verdict.daysRemaining).toBeCloseTo(10, 0)
  })

  // The common healthy case: retention is deleting as fast as sensors write.
  it('calls a flat series stable rather than inventing a date', () => {
    expect(forecastDiskFull(series(240, 100 * GB, 0)).kind).toBe('stable')
  })

  // Right after a purge, free space is climbing. A naive extrapolation would
  // say "full in -400 days", which renders as nonsense or, worse, as zero.
  it('calls rising free space stable, not filling', () => {
    expect(forecastDiskFull(series(240, 40 * GB, 5 * GB)).kind).toBe('stable')
  })

  // 40 MB/day against 100 GB free is 2500 days out. That is not a forecast,
  // it is a fit through sampler jitter.
  it('treats a trend smaller than the noise floor as stable', () => {
    expect(forecastDiskFull(series(240, 100 * GB, -0.04 * GB)).kind).toBe('stable')
  })

  it('says it cannot tell rather than guessing from three readings', () => {
    const verdict = forecastDiskFull(series(3, 100 * GB, -10 * GB))
    expect(verdict.kind).toBe('unknown')
    if (verdict.kind !== 'unknown') return
    expect(verdict.reason).toMatch(/not enough/i)
  })

  it('says it cannot tell when the window is shorter than an hour', () => {
    const verdict = forecastDiskFull(series(20, 100 * GB, -10 * GB).slice(0, 20))
    expect(verdict.kind).toBe('unknown')
  })

  // A gap is a gap: the sampler records null when it could not read the
  // filesystem, and a null must never be read as zero bytes free.
  it('ignores unreadable samples instead of treating them as zero', () => {
    const points = series(240, 100 * GB, -10 * GB)
    const withGaps = points.map((p, i) => (i % 5 === 0 ? { ...p, free: null } : p))
    const verdict = forecastDiskFull(withGaps)
    expect(verdict.kind).toBe('filling')
    if (verdict.kind !== 'filling') return
    expect(verdict.daysRemaining).toBeCloseTo(10, 0)
  })

  it('reports zero days when the disk is already full', () => {
    const verdict = forecastDiskFull(series(240, 0, -10 * GB))
    expect(verdict).toMatchObject({ kind: 'filling', daysRemaining: 0 })
  })

  it('is not thrown by one outlier at the end', () => {
    const points = series(240, 100 * GB, -10 * GB)
    const spiked = [...points.slice(0, -1), { ts: T0 + 239 * MINUTE, free: 5 * GB }]
    const verdict = forecastDiskFull(spiked)
    expect(verdict.kind).toBe('filling')
    if (verdict.kind !== 'filling') return
    // A first-to-last slope would read this as hours from full.
    expect(verdict.daysRemaining).toBeGreaterThan(0.2)
  })
})

describe('usedFraction', () => {
  it('computes the used share', () => {
    expect(usedFraction(100, 25)).toBeCloseTo(0.75)
  })

  // Every host figure can be unreadable, and a zero would draw an empty disk.
  it('is null when either figure is missing', () => {
    expect(usedFraction(null, 25)).toBeNull()
    expect(usedFraction(100, null)).toBeNull()
    expect(usedFraction(0, 0)).toBeNull()
  })

  it('clamps a free reading larger than the total', () => {
    expect(usedFraction(100, 200)).toBe(0)
  })
})

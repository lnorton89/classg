import { describe, expect, it } from 'vitest'

import type { CardPath } from './share-card-model'
import type { Position, Track } from '@/lib/api/types'

import {
  buildPath,
  buildShareCardModel,
  buildSignal,
  formatDuration,
  formatHeadline,
  formatSeen,
} from './share-card-model'
import { EMPTY } from '@/lib/format'
import { cardFilename } from './share-card-export'

function position(lat: number, lon: number, at = '2026-08-16T03:48:56.882Z'): Position {
  return { lat, lon, at }
}

const baseTrack: Track = {
  schema_version: '1.0',
  track_id: '01M04AZNXMQP74QM5HYS3MPJC4',
  state: 'CLOSED',
  first_seen: '2026-08-16T03:48:56.882Z',
  last_seen: '2026-08-16T03:49:55.122Z',
  detection_count: 262,
  confidence: 0.6,
  identity: { serial: '1581F9DEC259E0296040', vendor: 'dji', ua_type: 'multirotor' },
  evidence: [{ class: 'A', sensor_kind: 'wifi', weight: 0.6, count: 262 }],
  current: position(46.0400543, -122.7667999),
  history: [],
}

function track(overrides: Partial<Track> = {}): Track {
  return { ...baseTrack, ...overrides }
}

/** Fail loudly rather than reaching for `!` on a value the test requires. */
function pathOf(history: Position[]): CardPath {
  const path = buildPath(history)
  if (!path) throw new Error('expected buildPath to return a path')
  return path
}

function endsOf(path: CardPath) {
  const first = path.points.at(0)
  const last = path.points.at(-1)
  if (!first || !last) throw new Error('expected the path to have endpoints')
  return { first, last }
}

describe('buildShareCardModel', () => {
  it('carries coordinates when location is included', () => {
    const model = buildShareCardModel(track(), false)
    expect(model.coordinates).toBe('46.040054, -122.766800')
    expect(model.redacted).toBe(false)
  })

  it('removes coordinates and altitude when redacted', () => {
    const model = buildShareCardModel(
      track({ current: { ...position(46.04, -122.76), alt_geodetic_m: 19 } }),
      true,
    )
    expect(model.coordinates).toBeNull()
    expect(model.altitudeM).toBeNull()
    expect(model.redacted).toBe(true)
  })

  it('does not leak coordinates into any other field when redacted', () => {
    const serialised = JSON.stringify(buildShareCardModel(track(), true))
    expect(serialised).not.toContain('46.04')
    expect(serialised).not.toContain('122.76')
  })

  it('falls back from serial to MAC to track id for the title', () => {
    expect(buildShareCardModel(track(), false).title).toBe('1581F9DEC259E0296040')
    expect(
      buildShareCardModel(track({ identity: { macs: ['8c:1e:d9:fc:bb:cc'] } }), false).title,
    ).toBe('8c:1e:d9:fc:bb:cc')
    expect(buildShareCardModel(track({ identity: undefined }), false).title).toBe(
      '01M04AZNXMQP74QM5HYS3MPJC4',
    )
  })

  it('de-duplicates evidence classes and sensor kinds', () => {
    const model = buildShareCardModel(
      track({
        evidence: [
          { class: 'A', sensor_kind: 'wifi', weight: 0.6, count: 10 },
          { class: 'A', sensor_kind: 'wifi', weight: 0.6, count: 20 },
          { class: 'B', sensor_kind: 'sdr', weight: 0.3, count: 5 },
        ],
      }),
      false,
    )
    expect(model.evidenceClasses).toEqual(['A', 'B'])
    expect(model.sensorKinds).toEqual(['sdr', 'wifi'])
  })
})

describe('buildPath', () => {
  it('returns null when there are too few points to draw a line', () => {
    expect(buildPath([])).toBeNull()
    expect(buildPath([position(46, -122)])).toBeNull()
  })

  it('flags a parked aircraft as stationary rather than dividing by zero', () => {
    const path = pathOf([position(46, -122), position(46, -122), position(46, -122)])
    expect(path.stationary).toBe(true)
    expect(path.points).toHaveLength(1)
    expect(path.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })

  it('normalises into the unit box with north at the top', () => {
    const path = pathOf([position(46.0, -122.0), position(46.001, -122.0)])
    expect(path.stationary).toBe(false)
    // The northernmost point must have the SMALLER y — SVG counts downward.
    const { first, last } = endsOf(path)
    expect(last.y).toBeLessThan(first.y)
    for (const p of path.points) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(1)
    }
  })

  it('preserves aspect ratio instead of stretching a line to fill the box', () => {
    // A due-north leg must stay vertical, i.e. x is constant at the centre.
    const path = pathOf([position(46.0, -122.0), position(46.01, -122.0)])
    const xs = path.points.map((p) => p.x)
    expect(new Set(xs).size).toBe(1)
    expect(xs.at(0)).toBeCloseTo(0.5, 6)
  })

  it('downsamples long histories but keeps both endpoints', () => {
    const history = Array.from({ length: 500 }, (_, i) => position(46 + i * 1e-5, -122))
    const path = pathOf(history)
    expect(path.points.length).toBeLessThanOrEqual(120)
    const { first, last } = endsOf(path)
    expect(first.y).toBeCloseTo(1, 6)
    expect(last.y).toBeCloseTo(0, 6)
  })

  it('reports a span in metres for a moving track', () => {
    const path = pathOf([position(46.0, -122.0), position(46.001, -122.0)])
    // 0.001 degrees of latitude is ~111 m.
    expect(path.spanMetres).toBeGreaterThan(100)
    expect(path.spanMetres).toBeLessThan(120)
  })
})

describe('formatDuration', () => {
  it('renders sub-minute, minute and hour spans', () => {
    expect(formatDuration('2026-08-16T03:48:56Z', '2026-08-16T03:49:55Z')).toBe('59s')
    expect(formatDuration('2026-08-16T03:00:00Z', '2026-08-16T03:04:30Z')).toBe('4m 30s')
    expect(formatDuration('2026-08-16T01:00:00Z', '2026-08-16T03:30:00Z')).toBe('2h 30m')
  })

  it('refuses to invent a duration it does not have', () => {
    expect(formatDuration(undefined, '2026-08-16T03:49:55Z')).toBe('—')
    expect(formatDuration('2026-08-16T03:49:55Z', undefined)).toBe('—')
    expect(formatDuration('2026-08-16T03:49:55Z', '2026-08-16T03:48:00Z')).toBe('—')
  })
})

describe('cardFilename', () => {
  it('strips characters that are illegal in a filename', () => {
    expect(cardFilename('8c:1e:d9:fc:bb:cc', '2026-08-16T03:49:55.122Z')).toBe(
      'classg-8c-1e-d9-fc-bb-cc-2026-08-16-03-49-55.png',
    )
  })

  it('still produces a usable name with no identifier or timestamp', () => {
    expect(cardFilename('', null)).toBe('classg-track-unknown.png')
  })
})

describe('formatHeadline', () => {
  it('upper-cases short vendor acronyms and title-cases longer names', () => {
    expect(formatHeadline('dji', 'multirotor')).toBe('DJI Multirotor')
    expect(formatHeadline('parrot', 'multirotor')).toBe('Parrot Multirotor')
    expect(formatHeadline('skydio', 'helicopter')).toBe('Skydio Helicopter')
  })

  it('drops missing halves rather than printing an em dash in the headline', () => {
    expect(formatHeadline('dji', EMPTY)).toBe('DJI')
    expect(formatHeadline(EMPTY, 'multirotor')).toBe('Multirotor')
  })

  it('never leaves the headline blank', () => {
    expect(formatHeadline(EMPTY, EMPTY)).toBe('Unidentified aircraft')
    expect(formatHeadline('', '')).toBe('Unidentified aircraft')
  })
})

describe('formatSeen', () => {
  it('renders a UTC day and clock range', () => {
    expect(formatSeen('2026-08-16T03:48:56.882Z', '2026-08-16T03:49:55.122Z')).toBe(
      '16 Aug 2026, 03:48–03:49 UTC',
    )
  })

  it('returns the em dash for unparseable stamps', () => {
    expect(formatSeen('not-a-date', '2026-08-16T03:49:55Z')).toBe(EMPTY)
  })
})

describe('buildSignal', () => {
  const at = (i: number) => new Date(Date.UTC(2026, 7, 16, 3, 48, i)).toISOString()

  it('returns null below two samples — a single point is not a trace', () => {
    expect(buildSignal([])).toBeNull()
    expect(buildSignal([{ ts: at(0), rssi: -50 }])).toBeNull()
  })

  it('puts the stronger signal nearer the top', () => {
    const signal = buildSignal([
      { ts: at(0), rssi: -90 },
      { ts: at(1), rssi: -40 },
    ])
    const first = signal?.points.at(0)
    const last = signal?.points.at(-1)
    expect(last?.y).toBeLessThan(first?.y ?? 0)
  })

  it('reports the true peak, not the padded axis bound', () => {
    const signal = buildSignal([
      { ts: at(0), rssi: -73 },
      { ts: at(1), rssi: -51 },
    ])
    expect(signal?.peakRssi).toBe(-51)
    expect(signal?.maxRssi).toBeGreaterThanOrEqual(-51)
  })

  it('keeps every point inside the plot box', () => {
    const signal = buildSignal(
      Array.from({ length: 400 }, (_, i) => ({ ts: at(i % 60), rssi: -40 - (i % 50) })),
    )
    expect(signal?.points.length).toBeLessThanOrEqual(120)
    for (const p of signal?.points ?? []) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(1)
    }
  })
})

describe('ground track summary', () => {
  it('calls GPS jitter stationary instead of drawing it as a flight', () => {
    const history = Array.from({ length: 50 }, (_, i) => position(46 + i * 2e-7, -122))
    const model = buildShareCardModel(track({ history }), false)
    expect(model.movementLabel).toBe('Stationary')
    expect(model.path).toBeNull()
  })

  it('reports a real flight in metres and keeps its path', () => {
    const model = buildShareCardModel(
      track({ history: [position(46.0, -122.0), position(46.002, -122.0)] }),
      false,
    )
    expect(model.path).not.toBeNull()
    expect(model.movementLabel).toMatch(/^Moved ~2\d\d m$/)
  })

  it('has nothing to say when there is no history at all', () => {
    expect(buildShareCardModel(track({ history: [] }), false).movementLabel).toBe(EMPTY)
  })
})

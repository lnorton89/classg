import { describe, expect, it } from 'vitest'

import type { Position, Track } from '@/lib/api/types'

import {
  aircraftKey,
  aircraftLabel,
  DEFAULT_FLIGHT_SORT,
  flightDurationS,
  flightNeighbours,
  flightPositions,
  flightRangeMs,
  hasOperatorFix,
  maxHeightAglM,
  maxRangeM,
  maxSpeedMps,
  orderFlights,
  parseFlightSort,
  sortFlights,
  flightsAround,
} from './flight-metrics'

const RECEIVER = { lat: 51.5, lon: -0.1 }

function at(lon: number, heightAglM?: number | null): Position {
  return { lat: 51.5, lon, height_agl_m: heightAglM ?? null }
}

function flight(overrides: Partial<Track> & { track_id: string }): Track {
  return {
    schema_version: '1.0',
    state: 'CLOSED',
    first_seen: '2026-09-15T09:00:00Z',
    last_seen: '2026-09-15T09:10:00Z',
    detection_count: 10,
    confidence: 0.6,
    ...overrides,
  }
}

describe('aircraft identity', () => {
  it('prefers the serial, which survives MAC randomisation', () => {
    const track = flight({
      track_id: 'T1',
      identity: { serial: 'S1', macs: ['aa:bb:cc:dd:ee:ff'] },
    })
    expect(aircraftKey(track)).toBe('serial:S1')
    expect(aircraftLabel(track)).toBe('S1')
  })

  it('falls back to the primary MAC, then to the track id', () => {
    expect(aircraftKey(flight({ track_id: 'T2', identity: { macs: ['aa:bb'] } }))).toBe(
      'mac:aa:bb',
    )
    expect(aircraftKey(flight({ track_id: 'T3' }))).toBe('track:T3')
  })

  it('never keys two anonymous contacts the same', () => {
    // The failure this guards: a shared "unknown" bucket would state an
    // identity nothing established, presenting two contacts as one aircraft.
    expect(aircraftKey(flight({ track_id: 'T3' }))).not.toBe(
      aircraftKey(flight({ track_id: 'T4' })),
    )
  })
})

describe('flightDurationS', () => {
  it('is last_seen minus first_seen in seconds', () => {
    expect(flightDurationS(flight({ track_id: 'T1' }))).toBe(600)
  })

  it('returns null rather than a negative span when the clock moved', () => {
    expect(
      flightDurationS(
        flight({
          track_id: 'T1',
          first_seen: '2026-09-15T09:10:00Z',
          last_seen: '2026-09-15T09:00:00Z',
        }),
      ),
    ).toBeNull()
  })

  it('returns null for an unparseable timestamp', () => {
    expect(flightDurationS(flight({ track_id: 'T1', last_seen: 'not a time' }))).toBeNull()
  })
})

describe('flightPositions', () => {
  it('uses the history when there is one', () => {
    const track = flight({
      track_id: 'T1',
      history: [at(-0.1), at(-0.098)],
      current: at(-0.05),
    })
    expect(flightPositions(track)).toHaveLength(2)
  })

  it('falls back to the single current fix rather than reporting nothing', () => {
    const track = flight({ track_id: 'T1', current: at(-0.05) })
    expect(flightPositions(track)).toEqual([at(-0.05)])
  })

  it('is empty when the aircraft never reported a position', () => {
    expect(flightPositions(flight({ track_id: 'T1' }))).toEqual([])
  })
})

describe('maxRangeM', () => {
  it('is the furthest point from the receiver, not the last one', () => {
    const track = flight({
      track_id: 'T1',
      history: [at(-0.1), at(-0.098), at(-0.099)],
    })
    const metres = maxRangeM(track, RECEIVER)
    // 0.002 deg of longitude at 51.5 degrees north is about 138 m.
    expect(metres).toBeGreaterThan(137)
    expect(metres).toBeLessThan(140)
  })

  it('is null with no receiver position, rather than a number that looks measured', () => {
    const track = flight({ track_id: 'T1', history: [at(-0.1), at(-0.098)] })
    expect(maxRangeM(track, null)).toBeNull()
  })

  it('is null when the flight recorded no position at all', () => {
    expect(maxRangeM(flight({ track_id: 'T1' }), RECEIVER)).toBeNull()
  })
})

describe('maxHeightAglM', () => {
  it('is the highest point that carried a height', () => {
    const track = flight({
      track_id: 'T1',
      history: [at(-0.1, 12), at(-0.099, 64), at(-0.098)],
    })
    expect(maxHeightAglM(track)).toBe(64)
  })

  it('is null when no point carried one', () => {
    expect(
      maxHeightAglM(flight({ track_id: 'T1', history: [at(-0.1), at(-0.099)] })),
    ).toBeNull()
  })

  it('keeps a legitimate zero, which is an aircraft on the ground', () => {
    expect(maxHeightAglM(flight({ track_id: 'T1', history: [at(-0.1, 0)] }))).toBe(0)
  })
})

describe('hasOperatorFix', () => {
  it('is true only when the aircraft broadcast a pilot position', () => {
    expect(hasOperatorFix(flight({ track_id: 'T1' }))).toBe(false)
    expect(hasOperatorFix(flight({ track_id: 'T2', operator: null }))).toBe(false)
    expect(hasOperatorFix(flight({ track_id: 'T3', operator: { lat: 51.5, lon: -0.1 } }))).toBe(
      true,
    )
  })
})

describe('sortFlights', () => {
  const short = flight({
    track_id: 'short',
    first_seen: '2026-09-15T09:00:00Z',
    last_seen: '2026-09-15T09:01:00Z',
    history: [at(-0.1, 10), at(-0.0995)],
  })
  const long = flight({
    track_id: 'long',
    first_seen: '2026-09-14T09:00:00Z',
    last_seen: '2026-09-14T09:30:00Z',
    history: [at(-0.1, 80), at(-0.098)],
  })
  const unmeasured = flight({
    track_id: 'unmeasured',
    first_seen: '2026-09-13T09:00:00Z',
    last_seen: '2026-09-13T09:05:00Z',
  })

  it('defaults to most recent first', () => {
    expect(parseFlightSort(DEFAULT_FLIGHT_SORT)).toEqual({ column: 'start', desc: true })
    expect(
      sortFlights([unmeasured, short, long], DEFAULT_FLIGHT_SORT, RECEIVER).map(
        (t) => t.track_id,
      ),
    ).toEqual(['short', 'long', 'unmeasured'])
  })

  it('sinks unmeasured rows in BOTH directions', () => {
    // "We do not know" is not the lowest height of the day. Sorting it as if it
    // were would put a missing value at the top of "ascending height" and read
    // as a measurement.
    expect(
      sortFlights([unmeasured, short, long], 'agl-asc', RECEIVER).map((t) => t.track_id),
    ).toEqual(['short', 'long', 'unmeasured'])
    expect(
      sortFlights([unmeasured, short, long], 'agl-desc', RECEIVER).map((t) => t.track_id),
    ).toEqual(['long', 'short', 'unmeasured'])
  })

  it('sorts by derived duration and range, not by a stored field', () => {
    expect(
      sortFlights([short, long], 'duration-desc', RECEIVER).map((t) => t.track_id),
    ).toEqual(['long', 'short'])
    expect(sortFlights([short, long], 'range-desc', RECEIVER).map((t) => t.track_id)).toEqual([
      'long',
      'short',
    ])
  })

  it('treats every range as unmeasured when no receiver is configured', () => {
    const sorted = sortFlights([short, long], 'range-desc', null)
    expect(sorted.map((t) => t.track_id)).toEqual(['short', 'long'])
  })

  it('does not mutate the input array', () => {
    const input = [unmeasured, short, long]
    sortFlights(input, 'duration-asc', RECEIVER)
    expect(input.map((t) => t.track_id)).toEqual(['unmeasured', 'short', 'long'])
  })
})

describe('maxSpeedMps', () => {
  it('reports the fastest point that carried a speed', () => {
    const track = flight({
      track_id: 'T',
      history: [
        { lat: 51.5, lon: -0.1, speed_mps: 3 },
        { lat: 51.5, lon: -0.1, speed_mps: 11.4 },
        { lat: 51.5, lon: -0.1, speed_mps: 7 },
      ],
    })
    expect(maxSpeedMps(track)).toBe(11.4)
  })

  it('is null when no point reported one, rather than zero', () => {
    // Zero would read as "it never moved", which is a measurement nobody made.
    expect(maxSpeedMps(flight({ track_id: 'T', history: [at(-0.1)] }))).toBeNull()
  })
})

describe('orderFlights', () => {
  function started(id: string, firstSeen: string): Track {
    return flight({ track_id: id, first_seen: firstSeen })
  }

  it('orders oldest first by when the flight began', () => {
    const a = started('a', '2026-09-15T09:00:00Z')
    const b = started('b', '2026-09-14T09:00:00Z')
    const c = started('c', '2026-09-15T12:00:00Z')
    expect(orderFlights([a, b, c]).map((t) => t.track_id)).toEqual(['b', 'a', 'c'])
  })

  it('breaks a tie on track id so the order is total', () => {
    // Two halves of one sortie, split by a reception gap, can start in the
    // same second; an unstable order would make prev/next jump about.
    const x = started('x', '2026-09-15T09:00:00Z')
    const y = started('y', '2026-09-15T09:00:00Z')
    expect(orderFlights([y, x]).map((t) => t.track_id)).toEqual(['x', 'y'])
  })

  it('sinks flights with an unparseable start and leaves the input alone', () => {
    const good = started('good', '2026-09-15T09:00:00Z')
    const bad = started('bad', 'not a date')
    const input = [bad, good]
    expect(orderFlights(input).map((t) => t.track_id)).toEqual(['good', 'bad'])
    expect(input.map((t) => t.track_id)).toEqual(['bad', 'good'])
  })
})

describe('flightNeighbours', () => {
  const ordered = orderFlights([
    flight({ track_id: 'first', first_seen: '2026-09-14T09:00:00Z' }),
    flight({ track_id: 'middle', first_seen: '2026-09-15T09:00:00Z' }),
    flight({ track_id: 'last', first_seen: '2026-09-15T18:00:00Z' }),
  ])

  it('numbers a flight among its aircraft and names both neighbours', () => {
    const neighbours = flightNeighbours(ordered, 'middle')
    expect(neighbours).toMatchObject({ number: 2, total: 3 })
    expect(neighbours.previous?.track_id).toBe('first')
    expect(neighbours.next?.track_id).toBe('last')
  })

  it('has no previous at the start and no next at the end', () => {
    expect(flightNeighbours(ordered, 'first').previous).toBeNull()
    expect(flightNeighbours(ordered, 'last').next).toBeNull()
  })

  it('refuses to guess a position for a flight that is not in the list', () => {
    // Legitimate: the list is fetched by serial, and a track with none has no
    // such list to belong to.
    expect(flightNeighbours(ordered, 'elsewhere')).toEqual({
      number: null,
      total: 3,
      previous: null,
      next: null,
    })
  })
})

describe('flightRangeMs', () => {
  it('spans the first and last start', () => {
    const range = flightRangeMs([
      flight({ track_id: 'a', first_seen: '2026-09-15T09:00:00Z' }),
      flight({ track_id: 'b', first_seen: '2026-09-04T09:00:00Z' }),
    ])
    expect(range).toEqual({
      startMs: Date.parse('2026-09-04T09:00:00Z'),
      endMs: Date.parse('2026-09-15T09:00:00Z'),
    })
  })

  it('is null when nothing has a usable start', () => {
    expect(flightRangeMs([])).toBeNull()
  })
})

describe('flightsAround', () => {
  const flights = Array.from({ length: 17 }, (_, i) =>
    flight({
      track_id: `f${String(i + 1)}`,
      first_seen: `2026-09-${String(i + 1).padStart(2, '0')}T09:00:00Z`,
    }),
  )

  it('returns everything when the list fits', () => {
    const { items, from } = flightsAround(flights.slice(0, 5), 'f3', 12)
    expect(items.map((f) => f.track_id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5'])
    expect(from).toBe(0)
  })

  it('centres the window on the current flight', () => {
    // Flight 14 of 17 used to be off the end of an "earliest 12" strip.
    const { items, from } = flightsAround(flights, 'f14', 12)
    expect(items.map((f) => f.track_id)).toContain('f14')
    expect(from).toBe(5)
    expect(items).toHaveLength(12)
  })

  it('slides to the ends rather than shortening', () => {
    expect(flightsAround(flights, 'f2', 12).from).toBe(0)
    expect(flightsAround(flights, 'f17', 12).from).toBe(5)
    expect(flightsAround(flights, 'f17', 12).items.map((f) => f.track_id)).toContain('f17')
  })

  it('falls back to the start when the flight is not in the list', () => {
    const { from, items } = flightsAround(flights, 'missing', 12)
    expect(from).toBe(0)
    expect(items).toHaveLength(12)
  })
})

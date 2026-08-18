import { describe, expect, it } from 'vitest'

import { aircraftFromDetections } from './aircraft'
import type { Detection } from '@/lib/api/schema.gen'

function adsb(icao: string | undefined, ts: string, altitude?: number): Detection {
  return {
    schema_version: '1.0',
    detection_id: `${icao ?? 'none'}-${ts}`,
    ts,
    sensor_id: 'sdr-0',
    sensor_kind: 'sdr',
    detection_class: 'D',
    confidence: 0,
    ...(icao ? { adsb: { icao } } : {}),
    ...(altitude === undefined
      ? {}
      : { position: { lat: 46.035, lon: -122.1, alt_geodetic_m: altitude } }),
  } as Detection
}

describe('aircraftFromDetections', () => {
  // The observed shape from the unit: 200 detections, four aircraft, one of
  // them 132 times. The panel counted rows and told the operator there were
  // 200 aeroplanes overhead.
  it('collapses repeated reports of one aircraft into a single contact', () => {
    const detections = [
      adsb('A3A43A', '2026-08-17T19:52:57.189Z'),
      adsb('A3A43A', '2026-08-17T19:52:56.100Z'),
      adsb('A3A43A', '2026-08-17T19:52:55.000Z'),
      adsb('ABCF2F', '2026-08-17T19:50:00.000Z'),
    ]

    const contacts = aircraftFromDetections(detections)

    expect(contacts).toHaveLength(2)
    expect(contacts.map((c) => c.adsb?.icao)).toEqual(['A3A43A', 'ABCF2F'])
  })

  it('keeps the newest report for an aircraft, whatever order they arrive in', () => {
    const contacts = aircraftFromDetections([
      adsb('A3A43A', '2026-08-17T04:05:03.599Z', 1000),
      adsb('A3A43A', '2026-08-17T19:52:57.189Z', 1631),
      adsb('A3A43A', '2026-08-17T12:00:00.000Z', 1200),
    ])

    expect(contacts).toHaveLength(1)
    expect(contacts[0]?.ts).toBe('2026-08-17T19:52:57.189Z')
    expect(contacts[0]?.position?.alt_geodetic_m).toBe(1631)
  })

  it('orders contacts newest first', () => {
    const contacts = aircraftFromDetections([
      adsb('OLD', '2026-08-17T04:00:00.000Z'),
      adsb('NEW', '2026-08-17T19:00:00.000Z'),
      adsb('MID', '2026-08-17T12:00:00.000Z'),
    ])

    expect(contacts.map((c) => c.adsb?.icao)).toEqual(['NEW', 'MID', 'OLD'])
  })

  // Something the receiver heard but could not attribute is still a contact.
  // Dropping it would quietly shrink the picture, which is the failure this
  // codebase treats as worse than showing too much.
  it('keeps detections that carry no ICAO rather than discarding them', () => {
    const contacts = aircraftFromDetections([
      adsb('A3A43A', '2026-08-17T19:00:00.000Z'),
      adsb(undefined, '2026-08-17T18:00:00.000Z'),
      adsb(undefined, '2026-08-17T17:00:00.000Z'),
    ])

    expect(contacts).toHaveLength(3)
  })

  it('returns nothing for an empty feed', () => {
    expect(aircraftFromDetections([])).toEqual([])
  })
})

describe('aircraftFromDetections age bound', () => {
  const now = Date.parse('2026-08-18T12:00:00Z')

  function at(minutesAgo: number, icao: string): Detection {
    return {
      schema_version: '1.0',
      detection_id: `${icao}-${minutesAgo}`,
      ts: new Date(now - minutesAgo * 60_000).toISOString(),
      sensor_id: 'sdr-0',
      sensor_kind: 'sdr',
      detection_class: 'D',
      adsb: { icao },
    }
  }

  // The bug this closes: an aircraft last heard sixteen hours ago was plotted
  // beside one heard thirty-five minutes ago, and both were presented as
  // traffic that is up there right now.
  it('drops reports older than the window', () => {
    const out = aircraftFromDetections([at(1, 'AAA111'), at(960, 'BBB222')], 5 * 60_000, now)

    expect(out).toHaveLength(1)
    expect(out[0]?.adsb?.icao).toBe('AAA111')
  })

  it('keeps everything when no window is given', () => {
    const out = aircraftFromDetections([at(1, 'AAA111'), at(960, 'BBB222')])

    expect(out).toHaveLength(2)
  })

  it('keeps a report exactly at the edge', () => {
    const out = aircraftFromDetections([at(5, 'AAA111')], 5 * 60_000, now)

    expect(out).toHaveLength(1)
  })

  // A broken clock is a real report, and dropping contacts silently is worse
  // than showing one with an odd time.
  it('keeps a report whose timestamp will not parse', () => {
    const broken = { ...at(1, 'CCC333'), ts: 'not-a-date' }
    const out = aircraftFromDetections([broken], 5 * 60_000, now)

    expect(out).toHaveLength(1)
  })
})

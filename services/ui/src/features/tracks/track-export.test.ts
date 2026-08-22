import { describe, expect, it } from 'vitest'

import type { Position, Track } from '@/lib/api/types'

import { exportBasename, pathGeoJson, positionsCsv, rssiCsv } from './track-export'

const position = (over: Partial<Position> = {}): Position => ({
  lat: 46.8399,
  lon: -122.7673,
  at: '2026-08-21T03:14:15Z',
  ...over,
})

const track = (over: Partial<Track> = {}): Track => ({
  schema_version: '1.0',
  track_id: '01M0H4TT0MH1QW81DHVRX1PNE7',
  state: 'CLOSED',
  first_seen: '2026-08-21T03:11:33Z',
  last_seen: '2026-08-21T03:14:15Z',
  detection_count: 663,
  confidence: 0.6,
  evidence: [],
  identity: { serial: '1581F9DEC259E8296040' },
  adsb_correlated: false,
  ...over,
})

describe('positionsCsv', () => {
  it('emits one row per point with empty cells for unreported fields', () => {
    const csv = positionsCsv([
      position({ alt_geodetic_m: 11, speed_mps: 3.2 }),
      position({ at: '2026-08-21T03:14:16Z' }),
    ])
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('at,lat,lon,alt_geodetic_m,height_agl_m,speed_mps,track_deg')
    expect(lines[1]).toBe('2026-08-21T03:14:15Z,46.8399,-122.7673,11,,3.2,')
    expect(lines[2]).toBe('2026-08-21T03:14:16Z,46.8399,-122.7673,,,,')
  })
})

describe('pathGeoJson', () => {
  it('writes lon-lat order and carries identity as properties', () => {
    const parsed = JSON.parse(pathGeoJson(track(), [position({ alt_geodetic_m: 11 })])) as {
      features: {
        geometry: { type: string; coordinates: number[][] | number[] }
        properties: Record<string, unknown>
      }[]
    }
    expect(parsed.features[0]?.geometry.coordinates).toEqual([[-122.7673, 46.8399, 11]])
    expect(parsed.features[0]?.properties.serial).toBe('1581F9DEC259E8296040')
    expect(parsed.features).toHaveLength(1)
  })

  it('adds the operator point when one was broadcast', () => {
    const withOperator = track({
      operator: { lat: 46.84, lon: -122.77 },
    })
    const parsed = JSON.parse(pathGeoJson(withOperator, [position()])) as {
      features: { properties: Record<string, unknown> }[]
    }
    expect(parsed.features).toHaveLength(2)
    expect(parsed.features[1]?.properties.role).toBe('operator')
  })
})

describe('rssiCsv', () => {
  it('emits timestamp and dBm pairs', () => {
    const csv = rssiCsv([{ ts: '2026-08-21T03:12:12Z', rssi: -67 }])
    expect(csv).toBe('at,rssi_dbm\n2026-08-21T03:12:12Z,-67\n')
  })
})

describe('exportBasename', () => {
  it('prefers the serial and sanitises what it uses', () => {
    expect(exportBasename(track())).toBe('classg-track-1581F9DEC259E8296040')
    expect(exportBasename(track({ identity: { macs: ['8c:1e:d9:fc:bb:cc'] } }))).toBe(
      'classg-track-8c-1e-d9-fc-bb-cc',
    )
  })
})

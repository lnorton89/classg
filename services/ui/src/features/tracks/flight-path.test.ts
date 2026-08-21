import { describe, expect, it } from 'vitest'

import type { Detection, Position } from '@/lib/api/types'

import { flightPath } from './flight-path'

function detection(ts: string, lat: number | null, lon = -122.7): Detection {
  const d: Detection = {
    schema_version: '1.0',
    detection_id: `01J000000000000000000000${ts.slice(-2)}`,
    ts,
    sensor_id: 'wifi-0',
    sensor_kind: 'wifi',
    detection_class: 'A',
    position: lat === null ? null : { lat, lon },
  }
  return d
}

function point(at: string, lat: number): Position {
  return { lat, lon: -122.7, at }
}

describe('flightPath', () => {
  it('rebuilds the start of a flight the track no longer has', () => {
    // The measured case: a track whose ring buffer dropped its first points
    // while the detections that produced them are all still on disk.
    const detections = [
      detection('2026-08-21T03:11:33.394Z', 46.0399),
      detection('2026-08-21T03:12:10.194Z', 46.0401),
      detection('2026-08-21T03:14:15.950Z', 46.0403),
    ]
    const truncated = [point('2026-08-21T03:12:10.194Z', 46.0401)]

    const path = flightPath(detections, truncated)

    expect(path).toHaveLength(3)
    expect(path[0]?.at).toBe('2026-08-21T03:11:33.394Z')
  })

  it('returns the path oldest first, whatever order the API sent', () => {
    // The contract orders detections by timestamp DESC. Drawn in that order the
    // shape is identical, but "where it took off" becomes "where it landed".
    const path = flightPath(
      [
        detection('2026-08-21T03:14:15.950Z', 46.0403),
        detection('2026-08-21T03:11:33.394Z', 46.0399),
        detection('2026-08-21T03:12:10.194Z', 46.0401),
      ],
      [],
    )

    expect(path.map((p) => p.at)).toEqual([
      '2026-08-21T03:11:33.394Z',
      '2026-08-21T03:12:10.194Z',
      '2026-08-21T03:14:15.950Z',
    ])
  })

  it('drops detections that carry no position rather than plotting them at zero', () => {
    const path = flightPath(
      [
        detection('2026-08-21T03:11:33.394Z', 46.0399),
        detection('2026-08-21T03:11:34.000Z', null),
        detection('2026-08-21T03:11:35.000Z', 46.0401),
      ],
      [],
    )

    expect(path).toHaveLength(2)
  })

  it('keeps the track history when the detections cannot beat it', () => {
    // An ADS-B track, or one older than the detection retention window: the
    // stored history is the only surviving record and must not be replaced by
    // a single stray fix.
    const history = [
      point('2026-08-21T03:11:33.394Z', 46.0399),
      point('2026-08-21T03:12:10.194Z', 46.0401),
      point('2026-08-21T03:14:15.950Z', 46.0403),
    ]

    expect(flightPath([], history)).toBe(history)
    expect(flightPath([detection('2026-08-21T03:11:33.394Z', 46.0399)], history)).toBe(history)
  })

  it('carries altitude and kinematics through, not just the fix', () => {
    const d = detection('2026-08-21T03:11:33.394Z', 46.0399)
    d.position = { lat: 46.0399, lon: -122.7, alt_geodetic_m: 92 }
    d.kinematics = { speed_mps: 3.35, track_deg: 271 }

    const [p] = flightPath([d], [])

    expect(p?.alt_geodetic_m).toBe(92)
    expect(p?.speed_mps).toBe(3.35)
    expect(p?.track_deg).toBe(271)
  })
})

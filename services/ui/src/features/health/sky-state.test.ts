import { describe, expect, it } from 'vitest'

import type { Health, SensorHealth } from '@/lib/api/types'

import { computeSkyState } from './sky-state'

function sensor(
  id: string,
  kind: SensorHealth['sensor_kind'],
  detections: number,
): SensorHealth {
  return {
    sensor_id: id,
    sensor_kind: kind,
    healthy: true,
    last_heartbeat: '2026-09-15T18:00:00Z',
    seconds_since_heartbeat: 3,
    detections_5m: detections,
  }
}

function health(sensors: SensorHealth[]): Health {
  return { status: 'ok', uptime_s: 100, version: '0.1.0', sensors }
}

// The quiet-sky sentence used to add every sensor's five-minute count
// together and call the total "detections that did not correlate into a
// track". On this unit that total is the SDR's ADS-B reports -- 470 of them
// on 2026-09-15 -- which never become tracks by design, so the banner accused
// fusion of dropping hundreds of detections on a day with no drone at all.
describe('quiet sky wording', () => {
  it('names manned traffic as manned traffic', () => {
    const state = computeSkyState(
      health([
        sensor('wifi-0', 'wifi', 0),
        sensor('wifi-1', 'wifi', 0),
        sensor('sdr-0', 'sdr', 470),
      ]),
      0,
    )
    expect(state.kind).toBe('quiet')
    expect(state.detail).toBe(
      'All 3 sensors are reporting. 470 ADS-B reports from manned aircraft in the last 5 minutes and nothing from a drone — the empty map means an empty sky.',
    )
  })

  it('still reports drone-band detections that did not become a track', () => {
    const state = computeSkyState(
      health([sensor('wifi-0', 'wifi', 12), sensor('sdr-0', 'sdr', 0)]),
      0,
    )
    expect(state.detail).toBe(
      'All 2 sensors are reporting. 12 detections in the last 5 minutes did not correlate into a track.',
    )
  })

  it('keeps the two apart when both are present', () => {
    const state = computeSkyState(
      health([sensor('wifi-0', 'wifi', 12), sensor('adsb-net', 'net', 30)]),
      0,
    )
    expect(state.detail).toBe(
      'All 2 sensors are reporting. 12 detections in the last 5 minutes did not correlate into a track; the 30 ADS-B reports are manned aircraft.',
    )
  })

  it('says so when nothing at all was heard', () => {
    const state = computeSkyState(
      health([sensor('wifi-0', 'wifi', 0), sensor('sdr-0', 'sdr', 0)]),
      0,
    )
    expect(state.detail).toBe(
      'All 2 sensors are reporting and have seen nothing for 5 minutes. The empty map means an empty sky.',
    )
  })
})

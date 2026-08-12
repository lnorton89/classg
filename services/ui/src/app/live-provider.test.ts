import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { applyFrame } from './live-frames'
import { queryKeys } from '@/lib/api/queries'
import type { Detection, SensorHealth, Track, TracksResponse } from '@/lib/api/types'

/** Every server frame carries `ts`; the value is irrelevant to these assertions. */
const FRAME_TS = '2026-08-10T00:00:02Z'

function track(trackId: string): Track {
  return {
    schema_version: '1.0',
    track_id: trackId,
    state: 'CONFIRMED',
    first_seen: '2026-08-10T00:00:00Z',
    last_seen: '2026-08-10T00:00:01Z',
    detection_count: 2,
    identity: {},
    confidence: 0.6,
    adsb_correlated: false,
  }
}

function detection(
  detectionId: string,
  detectionClass: Detection['detection_class'],
): Detection {
  return {
    schema_version: '1.0',
    detection_id: detectionId,
    ts: '2026-08-10T00:00:00Z',
    sensor_id: 'sensor-0',
    sensor_kind: detectionClass === 'D' ? 'sdr' : 'wifi',
    detection_class: detectionClass,
  }
}

describe('applyFrame', () => {
  it('updates both track detail and every active track list', () => {
    const client = new QueryClient()
    const old = track('T1')
    const updated = { ...old, confidence: 0.8, detection_count: 3 }
    const response: TracksResponse = { tracks: [old], next_cursor: null, total: 1 }
    client.setQueryData(queryKeys.tracks(), response)
    client.setQueryData(queryKeys.tracks({ min_confidence: 0.5 }), response)

    applyFrame(client, { type: 'track.update', ts: FRAME_TS, track: updated })

    expect(client.getQueryData(queryKeys.track('T1'))).toMatchObject({ confidence: 0.8 })
    expect(client.getQueryData<TracksResponse>(queryKeys.tracks())?.tracks[0]).toMatchObject({
      detection_count: 3,
    })
    expect(
      client.getQueryData<TracksResponse>(queryKeys.tracks({ min_confidence: 0.5 }))?.tracks[0],
    ).toMatchObject({ confidence: 0.8 })
  })

  it('archives closed tracks in list and detail caches without changing totals', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.track('T1'), track('T1'))
    client.setQueryData<TracksResponse>(queryKeys.tracks(), {
      tracks: [track('T1')],
      next_cursor: null,
      total: 1,
    })

    applyFrame(client, { type: 'track.closed', ts: FRAME_TS, track_id: 'T1' })

    expect(client.getQueryData<TracksResponse>(queryKeys.tracks())).toMatchObject({
      tracks: [{ track_id: 'T1', state: 'CLOSED' }],
      total: 1,
    })
    expect(client.getQueryData<Track>(queryKeys.track('T1'))?.state).toBe('CLOSED')
  })

  it('only caches ADS-B detections from the live stream', () => {
    const client = new QueryClient()
    const query = queryKeys.detections({ class: ['D'], limit: 200 })
    client.setQueryData(query, { detections: [], next_cursor: null, total: 0 })

    applyFrame(client, { type: 'detection', ts: FRAME_TS, detection: detection('wifi', 'A') })
    applyFrame(client, { type: 'detection', ts: FRAME_TS, detection: detection('adsb', 'D') })

    expect(client.getQueryData<{ detections: Detection[] }>(query)?.detections).toEqual([
      expect.objectContaining({ detection_id: 'adsb' }),
    ])
  })

  it('does not erase runtime sensor config when a health frame arrives', () => {
    const client = new QueryClient()
    const configured: SensorHealth = {
      sensor_id: 'wifi-0',
      sensor_kind: 'wifi',
      healthy: false,
      last_heartbeat: '',
      seconds_since_heartbeat: 0,
      config: {
        unit: 'classg-sensor-wifi.service',
        stale_after_s: 30,
        expected: true,
        restart_command: 'systemctl restart classg-sensor-wifi.service',
        restart_available: false,
        capture: {
          supported: true,
          interface: 'wlan0',
          channel: 6,
          duration_s: 120,
          label: 'sensor-capture',
        },
      },
    }
    client.setQueryData(queryKeys.sensors, [configured])

    applyFrame(client, {
      type: 'health',
      ts: FRAME_TS,
      health: {
        status: 'ok',
        uptime_s: 10,
        version: 'test',
        sensors: [{ ...configured, healthy: true, config: undefined }],
      },
    })

    expect(
      client.getQueryData<SensorHealth[]>(queryKeys.sensors)?.[0]?.config?.capture,
    ).toMatchObject({ interface: 'wlan0', duration_s: 120 })
  })
})

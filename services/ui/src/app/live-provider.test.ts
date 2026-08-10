import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { applyFrame } from './live-provider'
import { queryKeys } from '@/lib/api/queries'
import type { Detection, ServerFrame, Track, TracksResponse } from '@/lib/api/types'

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

    applyFrame(client, { type: 'track.update', track: updated } as ServerFrame)

    expect(client.getQueryData(queryKeys.track('T1'))).toMatchObject({ confidence: 0.8 })
    expect(client.getQueryData<TracksResponse>(queryKeys.tracks())?.tracks[0]).toMatchObject({
      detection_count: 3,
    })
    expect(
      client.getQueryData<TracksResponse>(queryKeys.tracks({ min_confidence: 0.5 }))?.tracks[0],
    ).toMatchObject({ confidence: 0.8 })
  })

  it('removes closed tracks without underflowing totals', () => {
    const client = new QueryClient()
    client.setQueryData<TracksResponse>(queryKeys.tracks(), {
      tracks: [track('T1')],
      next_cursor: null,
      total: 1,
    })

    applyFrame(client, { type: 'track.closed', track_id: 'T1' })

    expect(client.getQueryData<TracksResponse>(queryKeys.tracks())).toMatchObject({
      tracks: [],
      total: 0,
    })
  })

  it('only caches ADS-B detections from the live stream', () => {
    const client = new QueryClient()
    const query = queryKeys.detections({ class: ['D'], limit: 200 })
    client.setQueryData(query, { detections: [], next_cursor: null, total: 0 })

    applyFrame(client, { type: 'detection', detection: detection('wifi', 'A') })
    applyFrame(client, { type: 'detection', detection: detection('adsb', 'D') })

    expect(client.getQueryData<{ detections: Detection[] }>(query)?.detections).toEqual([
      expect.objectContaining({ detection_id: 'adsb' }),
    ])
  })
})

import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { applyFrame } from './live-frames'
import { queryKeys } from '@/lib/api/queries'
import type {
  Detection,
  SensorHealth,
  SpectrumSweep,
  Track,
  TracksResponse,
} from '@/lib/api/types'

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

  it('respects each list cache’s own filters when inserting an unseen track', () => {
    const client = new QueryClient()
    const empty: TracksResponse = { tracks: [], next_cursor: null, total: 0 }
    // The notifications drawer's query: TENTATIVE is deliberately excluded.
    client.setQueryData(
      queryKeys.tracks({ state: ['CONFIRMED', 'COASTING', 'CLOSED'], limit: 100 }),
      empty,
    )
    // The timeline's since-window query.
    client.setQueryData(queryKeys.tracks({ since: '2026-08-11T00:00:00Z', limit: 1000 }), empty)
    client.setQueryData(queryKeys.tracks(), empty)

    const tentative = { ...track('T1'), state: 'TENTATIVE' as const }
    applyFrame(client, { type: 'track.update', ts: FRAME_TS, track: tentative })

    // Unfiltered list gains it; the filtered ones stay untouched, totals included.
    expect(client.getQueryData<TracksResponse>(queryKeys.tracks())).toMatchObject({
      tracks: [{ track_id: 'T1' }],
      total: 1,
    })
    expect(
      client.getQueryData<TracksResponse>(
        queryKeys.tracks({ state: ['CONFIRMED', 'COASTING', 'CLOSED'], limit: 100 }),
      ),
    ).toMatchObject({ tracks: [], total: 0 })
    expect(
      client.getQueryData<TracksResponse>(
        queryKeys.tracks({ since: '2026-08-11T00:00:00Z', limit: 1000 }),
      ),
    ).toMatchObject({ tracks: [], total: 0 })
  })

  it('removes a track from a filtered list when an update moves it outside the filter', () => {
    const client = new QueryClient()
    const key = queryKeys.tracks({ state: ['TENTATIVE'] })
    const tentative = { ...track('T1'), state: 'TENTATIVE' as const }
    client.setQueryData<TracksResponse>(key, {
      tracks: [tentative],
      next_cursor: null,
      total: 1,
    })

    applyFrame(client, {
      type: 'track.update',
      ts: FRAME_TS,
      track: { ...tentative, state: 'CONFIRMED' },
    })

    expect(client.getQueryData<TracksResponse>(key)).toMatchObject({ tracks: [], total: 0 })
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

  it('removes a closing track from a list whose filter excludes CLOSED', () => {
    // track.update learned to respect each entry's own filters; track.closed
    // has to as well, or closing a track parks it in a list that asked not to
    // see closed ones.
    const client = new QueryClient()
    const key = queryKeys.tracks({ state: ['TENTATIVE', 'CONFIRMED', 'COASTING'] })
    client.setQueryData<TracksResponse>(key, {
      tracks: [track('T1')],
      next_cursor: null,
      total: 1,
    })

    applyFrame(client, { type: 'track.closed', ts: FRAME_TS, track_id: 'T1' })

    expect(client.getQueryData<TracksResponse>(key)).toMatchObject({ tracks: [], total: 0 })
  })

  it('evicts only the overflow when closed tracks share a last_seen', () => {
    // Fusion closes tracks in batches on one reap tick, so ties are normal.
    // Comparing against a cutoff TIMESTAMP dropped every track sharing it --
    // tens of entries where two were meant to go.
    const client = new QueryClient()
    const tied = Array.from({ length: 520 }, (_, i) => ({
      ...track(`C${i}`),
      state: 'CLOSED' as const,
      last_seen: '2026-08-10T00:00:01Z',
    }))
    client.setQueryData<TracksResponse>(queryKeys.tracks(), {
      tracks: tied,
      next_cursor: null,
      total: tied.length,
    })

    // Appending one more track is what triggers eviction.
    applyFrame(client, { type: 'track.update', ts: FRAME_TS, track: track('NEW') })

    const after = client.getQueryData<TracksResponse>(queryKeys.tracks())
    const closed = (after?.tracks ?? []).filter((t) => t.state === 'CLOSED')
    expect(closed).toHaveLength(500)
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

    const merged = client.getQueryData<SensorHealth[]>(queryKeys.sensors)?.[0]
    expect(merged?.config?.capture).toMatchObject({ interface: 'wlan0', duration_s: 120 })
    // And the half that DOES come from the heartbeat moved. Keeping the cache
    // untouched preserved the config too, but left every sensor reading on
    // screen waiting for a poll while the header had already updated from this
    // same frame.
    expect(merged?.healthy).toBe(true)
  })

  it('takes sensor membership from health, since that is what knows', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.sensors, [
      {
        sensor_id: 'wifi-0',
        sensor_kind: 'wifi',
        healthy: true,
        last_heartbeat: '',
        seconds_since_heartbeat: 0,
      },
    ])

    applyFrame(client, {
      type: 'health',
      ts: FRAME_TS,
      health: {
        status: 'ok',
        uptime_s: 10,
        version: 'test',
        sensors: [
          {
            sensor_id: 'sdr-0',
            sensor_kind: 'sdr',
            healthy: true,
            last_heartbeat: '',
            seconds_since_heartbeat: 0,
          },
        ],
      },
    })

    expect(
      client.getQueryData<SensorHealth[]>(queryKeys.sensors)?.map((s) => s.sensor_id),
    ).toEqual(['sdr-0'])
  })

  /**
   * The bug this pins: the panel selects a sweep the moment it is started, so
   * the detail query fetches a record with no measurement in it. With a flat
   * `staleTime: Infinity` that empty record was cached forever and the chart
   * stayed blank after the sweep finished — only a page reload fixed it.
   */
  it("invalidates a sweep's detail when it settles, and never overwrites it", () => {
    const client = new QueryClient()
    const running: SpectrumSweep = {
      sweep_id: 'S1',
      band: 'ism_915',
      state: 'running',
      started_at: '2026-08-10T00:00:00Z',
    }
    client.setQueryData(queryKeys.spectrumSweeps, { sweeps: [running] })
    // A detail entry with a trace, standing in for one already fetched.
    const detailKey = queryKeys.spectrumSweep('S1', 1400)
    client.setQueryData(detailKey, { ...running, trace: { dbfs: [1, 2, 3] } })

    applyFrame(client, {
      type: 'sweep.status',
      ts: FRAME_TS,
      sweep: { ...running, state: 'completed', noise_floor_dbfs: -70 },
    })

    const list = client.getQueryData<{ sweeps: SpectrumSweep[] }>(queryKeys.spectrumSweeps)
    expect(list?.sweeps[0]).toMatchObject({ sweep_id: 'S1', state: 'completed' })

    // The frame carries the record and never the bins, so writing it into the
    // detail cache would replace a trace with a record that has none — the
    // chart would go blank at the moment the measurement arrived.
    expect(client.getQueryData<{ trace?: unknown }>(detailKey)?.trace).toBeDefined()
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true)
  })

  it('adds a sweep the list has never seen rather than dropping the frame', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.spectrumSweeps, { sweeps: [] })
    applyFrame(client, {
      type: 'sweep.status',
      ts: FRAME_TS,
      sweep: {
        sweep_id: 'S2',
        band: 'ism_868',
        state: 'running',
        started_at: '2026-08-10T00:00:00Z',
      },
    })
    expect(
      client.getQueryData<{ sweeps: SpectrumSweep[] }>(queryKeys.spectrumSweeps)?.sweeps,
    ).toHaveLength(1)
  })
})

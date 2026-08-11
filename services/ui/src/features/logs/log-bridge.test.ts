import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Health, ServerFrame, Track } from '@/lib/api/types'

import { createFrameLogger } from './log-bridge'
import { logStore } from './log-store'

const TS = '2026-08-10T02:14:07.000Z'

function track(overrides: Partial<Track> = {}): Track {
  return {
    schema_version: '1.0',
    track_id: 'T1',
    state: 'TENTATIVE',
    first_seen: TS,
    last_seen: TS,
    detection_count: 2,
    identity: { serial: '1581F5FMD24C1000ABCD' },
    confidence: 0.3,
    ...overrides,
  }
}

function update(t: Track): ServerFrame {
  return { type: 'track.update', ts: TS, track: t }
}

function health(status: Health['status'], healthy: boolean): ServerFrame {
  return {
    type: 'health',
    ts: TS,
    health: {
      status,
      uptime_s: 10,
      version: 'test',
      sensors: [
        {
          sensor_id: 'wifi-0',
          sensor_kind: 'wifi',
          healthy,
          last_heartbeat: TS,
          seconds_since_heartbeat: 1,
          ...(healthy ? {} : { reason: 'no frames for 120 s' }),
        },
      ],
    },
  }
}

function messages(): string[] {
  vi.advanceTimersByTime(300)
  return logStore.getSnapshot().map((entry) => entry.message)
}

describe('createFrameLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    logStore.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs a track once when it appears, not once per frame', () => {
    // A confirmed drone beacons at ~1 Hz. Logging every frame would bury the
    // one line that matters under hundreds that do not.
    const logFrame = createFrameLogger()
    const t = track()
    logFrame(update(t))
    logFrame(update(t))
    logFrame(update({ ...t, last_seen: '2026-08-10T02:14:08.000Z' }))

    expect(messages()).toEqual(['Track opened: 1581F5FMD24C1000ABCD'])
  })

  it('logs state changes and the confirmation threshold crossing', () => {
    const logFrame = createFrameLogger()
    logFrame(update(track()))
    logFrame(update(track({ state: 'CONFIRMED', confidence: 0.72 })))

    expect(messages()).toEqual([
      'Track opened: 1581F5FMD24C1000ABCD',
      'Track 1581F5FMD24C1000ABCD: TENTATIVE → CONFIRMED',
      'Track 1581F5FMD24C1000ABCD crossed the confirmation threshold',
    ])
  })

  it('flags a track that stops reporting position', () => {
    // The track stays in the table but vanishes from the map. That discrepancy
    // is invisible anywhere else in the interface.
    const logFrame = createFrameLogger()
    logFrame(update(track({ current: { lat: 51.4, lon: -0.1 } })))
    logFrame(update(track()))

    expect(messages().at(-1)).toBe(
      'Track 1581F5FMD24C1000ABCD stopped reporting position — no longer on the map',
    )
  })

  it('announces a sensor failing and recovering, but not a healthy first sighting', () => {
    const logFrame = createFrameLogger()
    logFrame(health('ok', true))
    expect(messages()).toEqual([])

    logFrame(health('degraded', false))
    logFrame(health('degraded', false))
    logFrame(health('ok', true))

    expect(messages()).toEqual([
      'System status ok → degraded',
      'Sensor wifi-0 unhealthy',
      'System status degraded → ok',
      'Sensor wifi-0 recovered',
    ])
  })

  it('treats a pause as a warning and ignores repeats of the same state', () => {
    // Not recording is the state this system exists to avoid being in silently,
    // even when an operator chose it.
    const logFrame = createFrameLogger()
    const paused: ServerFrame = {
      type: 'monitoring',
      ts: TS,
      monitoring: {
        enabled: false,
        since: TS,
        reason: 'test flight',
        discarded_while_paused: 4,
      },
    }
    logFrame(paused)
    logFrame(paused)

    expect(messages()).toEqual(['Recording paused'])
    const [entry] = logStore.getSnapshot()
    expect(entry?.level).toBe('warn')
    expect(entry?.detail).toMatchObject({ reason: 'test flight', discarded_while_paused: 4 })
  })
})

import { describe, expect, it } from 'vitest'

import { summariseStatus } from './status-summary'
import type { StatusInputs } from './status-summary'
import type { Health, MonitoringState } from '@/lib/api/types'

function health(status: Health['status'], healthy: number, unhealthy = 0): Health {
  const sensors = [
    ...Array.from({ length: healthy }, (_u, i) => sensor(`ok-${i}`, true)),
    ...Array.from({ length: unhealthy }, (_u, i) => sensor(`bad-${i}`, false)),
  ]
  return { status, uptime_s: 10, version: '0.1.0', sensors } as Health
}

function sensor(id: string, healthy: boolean) {
  return {
    sensor_id: id,
    sensor_kind: 'wifi',
    healthy,
    last_heartbeat: '2026-08-11T12:00:00Z',
    seconds_since_heartbeat: 1,
    detections_5m: 0,
  }
}

const recording: MonitoringState = {
  enabled: true,
  since: '2026-08-11T12:00:00Z',
  discarded_while_paused: 0,
}

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return { health: health('ok', 2), monitoring: recording, connection: 'open', ...over }
}

describe('summariseStatus', () => {
  it('is healthy when nothing is wrong', () => {
    expect(summariseStatus(inputs())).toMatchObject({ tone: 'ok', label: 'Healthy' })
  })

  it('reports an unreachable API above everything it can no longer check', () => {
    const s = summariseStatus(inputs({ healthError: true, health: undefined }))
    expect(s).toMatchObject({ tone: 'down', label: 'No API' })
  })

  it('does not guess before the first health report', () => {
    expect(summariseStatus(inputs({ health: undefined })).tone).toBe('unknown')
  })

  it('reports no coverage when every sensor is down', () => {
    const s = summariseStatus(inputs({ health: health('down', 0, 2) }))
    expect(s).toMatchObject({ tone: 'down', label: 'No coverage' })
  })

  // The ordering that matters most: a paused recorder has no other symptom.
  // Sensors are green, the map moves, and nothing is kept.
  it('puts paused above a degraded sensor', () => {
    const s = summariseStatus(
      inputs({
        health: health('degraded', 1, 1),
        monitoring: { ...recording, enabled: false },
      }),
    )
    expect(s.label).toBe('Paused')
  })

  // But not above total loss of coverage: nothing is being detected to pause.
  it('puts no coverage above paused', () => {
    const s = summariseStatus(
      inputs({ health: health('down', 0, 2), monitoring: { ...recording, enabled: false } }),
    )
    expect(s.label).toBe('No coverage')
  })

  it('counts the unhealthy sensors, in the singular when there is one', () => {
    expect(summariseStatus(inputs({ health: health('degraded', 1, 1) })).label).toBe(
      '1 sensor down',
    )
    expect(summariseStatus(inputs({ health: health('degraded', 1, 2) })).label).toBe(
      '2 sensors down',
    )
  })

  // A degraded sensor outranks a dropped socket: one is a dead radio, the
  // other is a browser that will reconnect.
  it('puts a down sensor above a stale screen', () => {
    const s = summariseStatus(
      inputs({ health: health('degraded', 1, 1), connection: 'closed' }),
    )
    expect(s.label).toBe('1 sensor down')
  })

  it('reports a stale screen when only the stream is down', () => {
    const s = summariseStatus(inputs({ connection: 'closed' }))
    expect(s).toMatchObject({ tone: 'warn', label: 'Stale' })
    expect(s.detail).toMatch(/detector is fine/i)
  })

  it('counts what was discarded while paused, when anything was', () => {
    const s = summariseStatus(
      inputs({ monitoring: { ...recording, enabled: false, discarded_while_paused: 42 } }),
    )
    expect(s.detail).toContain('42')
  })

  // Recording state arrives on its own query. Until it does, absence must not
  // read as "paused" -- that would flash a false alarm on every page load.
  it('does not report paused before the recording state has loaded', () => {
    expect(summariseStatus(inputs({ monitoring: undefined })).label).toBe('Healthy')
  })
})

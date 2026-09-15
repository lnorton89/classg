import { describe, expect, it } from 'vitest'

import type { SensorHealth } from '@/lib/api/types'

import { summariseSensor } from './sensor-summary'

function sensor(
  kind: SensorHealth['sensor_kind'],
  detail: Record<string, unknown> = {},
  overrides: Partial<SensorHealth> = {},
): SensorHealth {
  return {
    sensor_id: `${kind}-0`,
    sensor_kind: kind,
    healthy: true,
    last_heartbeat: '2026-09-15T00:00:00Z',
    seconds_since_heartbeat: 2,
    detail,
    ...overrides,
  }
}

function ids(sensorHealth: SensorHealth): string[] {
  return summariseSensor(sensorHealth).metrics.map((metric) => metric.id)
}

describe('summariseSensor', () => {
  it('leads a Wi-Fi sensor with what it heard and what it cost', () => {
    const wifi = sensor(
      'wifi',
      {
        beacons: 8_100_000,
        detections: 13_708,
        listening_fraction: 0.86,
        hop_overhead_ms: 3_000_000,
        hops: 41_000,
        subscribers: 1,
        plan_swaps: 3,
      },
      { detections_5m: 2 },
    )
    expect(ids(wifi)).toEqual([
      'heard',
      'detections',
      'detections-5m',
      'listening',
      'hop-overhead',
      'heartbeat',
    ])
  })

  it('asks a different question of the SDR, which does not hop', () => {
    const sdr = sensor('sdr', {
      messages_read: 500_000,
      parsed: 480_000,
      icaos: 190,
      parse_errors: 12,
      uptime_s: 59_979.8,
    })
    expect(ids(sdr)).toEqual(['read', 'parsed', 'icaos', 'parse-errors', 'uptime', 'heartbeat'])
  })

  it('still produces a strip for a sensor kind this build has never seen', () => {
    // The alternative is a page that silently loses its hierarchy the day a
    // third radio arrives.
    const other = sensor('acoustic' as SensorHealth['sensor_kind'], { detections: 4 })
    expect(ids(other)).toEqual(['detections', 'heartbeat'])
  })

  it('drops a tile whose counter the sensor does not report', () => {
    expect(ids(sensor('wifi', { beacons: 10 }))).toEqual(['heard', 'heartbeat'])
  })

  it('falls back from beacons to frames, and says which it used', () => {
    const framed = summariseSensor(sensor('wifi', { frames: 42 }))
    const heard = framed.metrics.find((metric) => metric.id === 'heard')
    expect(heard?.value).toBe(42)
    expect(heard?.hint).toBe('frames')
    expect(framed.consumed).toContain('frames')
    expect(framed.consumed).not.toContain('beacons')
  })

  it('ignores a counter that is not a number rather than rendering NaN', () => {
    // `detail` has no schema -- the API passes whatever the sensor sends.
    expect(ids(sensor('wifi', { beacons: 'lots', detections: 3 }))).toEqual([
      'detections',
      'heartbeat',
    ])
  })

  it('never makes a quiet sky look like a fault', () => {
    const quiet = summariseSensor(
      sensor('wifi', { beacons: 1000, detections: 0 }, { detections_5m: 0 }),
    )
    const detections = quiet.metrics.find((metric) => metric.id === 'detections')
    expect(detections?.tone).not.toBe('warn')
    expect(detections?.tone).not.toBe('down')
    expect(quiet.metrics.find((metric) => metric.id === 'detections-5m')?.hint).toBe(
      'quiet, not deaf',
    )
  })

  it('carries an unhealthy sensor on the heartbeat tile', () => {
    const dead = summariseSensor(sensor('wifi', {}, { healthy: false, reason: 'no device' }))
    expect(dead.metrics.find((metric) => metric.id === 'heartbeat')?.tone).toBe('down')
  })

  it('flags a receiver spending most of its life retuning', () => {
    const thrashing = summariseSensor(sensor('wifi', { listening_fraction: 0.4 }))
    expect(thrashing.metrics.find((metric) => metric.id === 'listening')?.tone).toBe('warn')
    const settled = summariseSensor(sensor('wifi', { listening_fraction: 0.9 }))
    expect(settled.metrics.find((metric) => metric.id === 'listening')?.tone).toBe('default')
  })

  it('reports the keys it consumed, so the full list can omit exactly those', () => {
    const { consumed } = summariseSensor(
      sensor('wifi', { beacons: 1, detections: 2, hops: 3, hop_overhead_ms: 4 }),
    )
    expect(consumed).toContain('beacons')
    expect(consumed).toContain('hop_overhead_ms')
    // `hops` is a caption on the hop-overhead tile, not a tile of its own, so
    // it keeps its row in the full list.
    expect(consumed).not.toContain('hops')
  })
})

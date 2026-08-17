/**
 * Telemetry history — one sample a minute, generated on demand.
 *
 * Deterministic on the absolute minute number so dev and tests see the same
 * curves on every reload, and — the part that matters — so the default 6 h
 * window ALWAYS contains null readings and a sampler outage. The gap-drawing
 * path in the charts is exercised by default rather than only when the real
 * API happens to fail; a mock that only ever serves the happy path would let a
 * zero-interpolating chart look correct all through development.
 */
import type { TelemetrySample } from '@/lib/api/types'

const MINUTE_MS = 60_000

/** Deterministic pseudo-noise in [0, 1) from the absolute minute number. */
function noise(minute: number, salt: number): number {
  const x = Math.sin(minute * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Every ~97 minutes the thermal read "fails" for 9 minutes: /sys/class/thermal
 * flaking is the real failure this models, and 9 consecutive nulls make the
 * gap wide enough to see at 6 h. The other figures fail on their own primes so
 * the gaps never line up suspiciously.
 */
function sampleAt(minute: number): TelemetrySample {
  const cpuNull = minute % 97 >= 40 && minute % 97 < 49
  const loadNull = minute % 419 < 2
  const memNull = minute % 353 < 3
  const diskNull = minute % 211 < 3

  // A slow evening thermal curve with minute-to-minute jitter, plus a load
  // swell every ~3 h that the temperature loosely follows.
  const swell = Math.sin(minute / 28) * 0.5 + 0.5
  const cpuTemp = 44 + 6 * Math.sin(minute / 90) + 2.5 * swell + noise(minute, 1) * 1.2
  const load1 = Math.max(0.02, 0.35 + swell * 1.1 + noise(minute, 2) * 0.3)
  const memAvailable = Math.round(3_409_708 - swell * 260_000 - noise(minute, 3) * 40_000)
  // Disk drains slowly and monotonically — detections accumulate.
  const diskFree = 92_687_323_136 - (minute % 100_000) * 350_000
  const uptime = (minute % 20_160) * 60 + 47

  return {
    ts: new Date(minute * MINUTE_MS).toISOString(),
    cpu_temp_c: cpuNull ? null : Number(cpuTemp.toFixed(2)),
    load1: loadNull ? null : Number(load1.toFixed(2)),
    mem_available_kb: memNull ? null : memAvailable,
    disk_free_bytes: diskNull ? null : diskFree,
    uptime_s: uptime,
    sensors: [
      {
        sensor_id: 'wifi-0',
        sensor_kind: 'wifi',
        healthy: minute % 631 >= 8,
        metrics: {
          beacons: 15_000 + (minute % 1000) * 11,
          listening_fraction: Number((0.68 + noise(minute, 4) * 0.12).toFixed(2)),
        },
      },
      {
        sensor_id: 'sdr-0',
        sensor_kind: 'sdr',
        healthy: true,
        metrics: { sweeps: 4_000 + (minute % 1000) * 3 },
      },
    ],
  }
}

/**
 * Ascending samples covering [since, until], minute-aligned.
 *
 * Every ~487 minutes the sampler itself "goes down" for 14 minutes and the rows
 * are simply absent — distinct from a null field, which is a row the sampler
 * wrote but a reading the api could not take. Charts must show both as gaps.
 */
export function telemetrySamples(sinceMs: number, untilMs: number): TelemetrySample[] {
  const first = Math.ceil(sinceMs / MINUTE_MS)
  const last = Math.floor(untilMs / MINUTE_MS)
  const samples: TelemetrySample[] = []
  for (let minute = first; minute <= last; minute++) {
    if (minute % 487 >= 300 && minute % 487 < 314) continue
    samples.push(sampleAt(minute))
  }
  return samples
}

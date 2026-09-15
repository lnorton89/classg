/**
 * Which handful of a sensor's forty counters answer the question the page is
 * for.
 *
 * The Sensors page had the richest data in the app and no hierarchy over it: a
 * forty-row key-value dump in which "8.1 million beacons heard, 13,708 drone
 * detections, 50 minutes lost to hopping" — a story about how this receiver
 * spends its life — sat between `plan_swaps` and `subscribers` at the same
 * weight. This module is the claim about which rows are the story. Everything
 * it does not pick still renders, behind the page's "All counters" disclosure.
 *
 * Kind-aware, because the two radios are not doing the same job: the Wi-Fi
 * sensor hops channels looking for drones and the interesting question is what
 * that hopping costs, while the SDR sits on 1090 MHz and the interesting
 * question is how much of what it hears it can parse.
 *
 * Returns a *description* of each metric rather than a formatted string. The
 * formatting belongs to `useFormat()` — see the UI README's Units section, and
 * the rule that no component formats a measurement itself — and keeping it out
 * of here is also what makes the selection testable without a React tree.
 */
import type { StatTone } from '@/components/ui/stat'
import type { SensorHealth } from '@/lib/api/types'

/** How the value wants to be rendered. Mirrors `DetailKind` in sensor-detail-groups. */
export type SummaryKind = 'count' | 'fraction' | 'millis' | 'seconds'

export interface SummaryMetric {
  id: string
  label: string
  kind: SummaryKind
  value: number
  hint?: string
  tone?: StatTone
}

export interface SensorSummary {
  metrics: SummaryMetric[]
  /**
   * The `detail` keys the strip consumed, so the full counter list can omit
   * them and no reading is printed twice. Derived per sensor rather than from
   * a fixed table: which key a tile fell back to depends on what this
   * particular sensor reported.
   */
  consumed: string[]
}

/**
 * Reads a counter and records that it was read.
 *
 * Detail values arrive untyped — the API passes a sensor's `detail` map
 * through without a schema — so anything non-numeric is not a counter, and a
 * future sensor that reports `beacons` as a string degrades to "the tile is
 * absent" rather than to `NaN`.
 */
function reader(detail: Record<string, unknown>, consumed: Set<string>) {
  return (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = detail[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        consumed.add(key)
        return value
      }
    }
    return undefined
  }
}

/**
 * The share of its time the radio spent listening rather than retuning.
 *
 * Below three quarters is worth flagging: at that point the channel plan is
 * costing more coverage than a wider dwell would, which is a calibration
 * decision an operator can actually act on. It is not a fault, so it is warn
 * and never down.
 */
const LISTENING_FLOOR = 0.75

function heartbeat(sensor: SensorHealth): SummaryMetric {
  return {
    id: 'heartbeat',
    label: 'Last heartbeat',
    kind: 'seconds',
    value: sensor.seconds_since_heartbeat,
    // A degraded sensor's reason belongs on the card, not squeezed into a
    // tile; the tone is what carries it here.
    tone: sensor.healthy ? 'default' : 'down',
  }
}

function wifiMetrics(
  sensor: SensorHealth,
  read: ReturnType<typeof reader>,
  detail: Record<string, unknown>,
): SummaryMetric[] {
  const metrics: SummaryMetric[] = []

  const heard = read('beacons', 'frames')
  if (heard !== undefined) {
    metrics.push({
      id: 'heard',
      label: 'Heard',
      kind: 'count',
      value: heard,
      hint: typeof detail.beacons === 'number' ? 'beacons' : 'frames',
    })
  }

  const detections = read('detections')
  if (detections !== undefined) {
    metrics.push({
      id: 'detections',
      label: 'Drone detections',
      kind: 'count',
      value: detections,
      // Never `warn` at zero. Zero detections from a healthy Wi-Fi sensor is a
      // quiet sky, and the whole product depends on that not looking like a
      // fault -- the fault case is the sensor being unhealthy, which the
      // heartbeat tile already carries.
      tone: detections > 0 ? 'ok' : 'default',
      hint: 'since this sensor started',
    })
  }

  if (sensor.detections_5m !== undefined) {
    metrics.push({
      id: 'detections-5m',
      label: 'Last 5 minutes',
      kind: 'count',
      value: sensor.detections_5m,
      hint: sensor.detections_5m === 0 && sensor.healthy ? 'quiet, not deaf' : undefined,
      tone: sensor.detections_5m === 0 ? 'muted' : 'default',
    })
  }

  const listening = read('listening_fraction')
  if (listening !== undefined) {
    metrics.push({
      id: 'listening',
      label: 'Listening share',
      kind: 'fraction',
      value: listening,
      hint: 'of the time, not retuning',
      tone: listening < LISTENING_FLOOR ? 'warn' : 'default',
    })
  }

  const lost = read('hop_overhead_ms')
  if (lost !== undefined) {
    // Read, not consumed: the hop count is a caption here, and it is still
    // worth a row of its own in the full list.
    const hops = typeof detail.hops === 'number' ? detail.hops : undefined
    metrics.push({
      id: 'hop-overhead',
      label: 'Lost to hopping',
      kind: 'millis',
      value: lost,
      hint: hops === undefined ? undefined : `${hops.toLocaleString()} hops`,
    })
  }

  metrics.push(heartbeat(sensor))
  return metrics
}

function sdrMetrics(sensor: SensorHealth, read: ReturnType<typeof reader>): SummaryMetric[] {
  const metrics: SummaryMetric[] = []

  const messages = read('messages_read', 'frames')
  if (messages !== undefined) {
    metrics.push({ id: 'read', label: 'Messages read', kind: 'count', value: messages })
  }

  const parsed = read('parsed')
  if (parsed !== undefined) {
    metrics.push({
      id: 'parsed',
      label: 'Parsed',
      kind: 'count',
      value: parsed,
      hint:
        messages !== undefined && messages > 0
          ? `${((parsed / messages) * 100).toFixed(0)}% of what it read`
          : undefined,
    })
  }

  const icaos = read('icaos')
  if (icaos !== undefined) {
    metrics.push({
      id: 'icaos',
      label: 'Aircraft heard',
      kind: 'count',
      value: icaos,
      // ADS-B is context, never a detection: manned traffic by design never
      // becomes a track. Naming that here stops the tile reading as a miss.
      hint: 'manned traffic, context only',
    })
  }

  const errors = read('parse_errors')
  if (errors !== undefined) {
    metrics.push({
      id: 'parse-errors',
      label: 'Parse errors',
      kind: 'count',
      value: errors,
      tone: errors > 0 ? 'warn' : 'default',
    })
  }

  const uptime = read('uptime_s')
  if (uptime !== undefined) {
    metrics.push({ id: 'uptime', label: 'Sensor uptime', kind: 'seconds', value: uptime })
  }

  metrics.push(heartbeat(sensor))
  return metrics
}

/**
 * The summary strip for one sensor.
 *
 * A sensor kind this build has never heard of still gets a strip — the
 * readings every sensor has, whatever it is — rather than nothing, because the
 * alternative is a page that silently loses its hierarchy the day a third
 * radio arrives.
 */
export function summariseSensor(sensor: SensorHealth): SensorSummary {
  const detail = sensor.detail ?? {}
  const consumed = new Set<string>()
  const read = reader(detail, consumed)

  let metrics: SummaryMetric[]
  if (sensor.sensor_kind === 'wifi') {
    metrics = wifiMetrics(sensor, read, detail)
  } else if (sensor.sensor_kind === 'sdr') {
    metrics = sdrMetrics(sensor, read)
  } else {
    metrics = []
    const detections = read('detections')
    if (detections !== undefined) {
      metrics.push({
        id: 'detections',
        label: 'Detections',
        kind: 'count',
        value: detections,
        tone: detections > 0 ? 'ok' : 'default',
      })
    }
    const uptime = read('uptime_s')
    if (uptime !== undefined) {
      metrics.push({ id: 'uptime', label: 'Sensor uptime', kind: 'seconds', value: uptime })
    }
    metrics.push(heartbeat(sensor))
  }

  return { metrics, consumed: [...consumed] }
}

/**
 * "What does an empty map mean right now?"
 *
 * This is the single most important computation in the app. From the contract:
 *
 *   "An empty map with an unhealthy sensor must look visibly different from an
 *    empty map with all sensors healthy. This is the single most important thing
 *    the interface communicates."
 *
 * Keeping it as a pure function of (health, trackCount) means the distinction is
 * unit-testable rather than a styling accident that a later refactor can quietly
 * undo.
 */
import type { Health, SensorHealth } from '@/lib/api/types'

export type SkyStateKind =
  /** Tracks present and coverage is good. */
  | 'active'
  /** Tracks present but at least one sensor is down: what you see is incomplete. */
  | 'active-degraded'
  /** No tracks, every sensor healthy. The empty map is evidence. */
  | 'quiet'
  /** No tracks, some sensors down. The empty map is NOT evidence. */
  | 'degraded'
  /** No healthy sensors at all. Nothing on screen means anything. */
  | 'blind'
  /** Health itself is unknown — API unreachable, first load. */
  | 'unknown'

export interface SkyState {
  kind: SkyStateKind
  /** Is the absence of tracks meaningful? The whole point of this module. */
  absenceIsEvidence: boolean
  /** Short headline, e.g. "Quiet sky". */
  title: string
  /** One sentence stating what the operator may and may not conclude. */
  detail: string
  tone: 'ok' | 'warn' | 'down' | 'muted'
  unhealthy: SensorHealth[]
  healthy: SensorHealth[]
  trackCount: number
}

function describeSensors(sensors: SensorHealth[]): string {
  if (sensors.length === 0) return ''
  const names = sensors.map((s) => `${s.sensor_id} (${s.reason ?? 'no heartbeat'})`)
  if (names.length === 1) return names[0] as string
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`
}

export function computeSkyState(health: Health | undefined, trackCount: number): SkyState {
  if (!health) {
    return {
      kind: 'unknown',
      absenceIsEvidence: false,
      title: 'Sensor status unknown',
      detail:
        'The API has not reported health yet. Do not read anything into what is or is not on the map.',
      tone: 'muted',
      unhealthy: [],
      healthy: [],
      trackCount,
    }
  }

  const healthy = health.sensors.filter((s) => s.healthy)
  const unhealthy = health.sensors.filter((s) => !s.healthy)
  const base = { unhealthy, healthy, trackCount }

  if (healthy.length === 0) {
    return {
      ...base,
      kind: 'blind',
      absenceIsEvidence: false,
      title: 'No sensor coverage',
      detail:
        health.sensors.length === 0
          ? 'No sensors are registered. Nothing on this screen is evidence of anything.'
          : `Every sensor is unhealthy: ${describeSensors(unhealthy)}. Nothing on this screen is evidence of anything.`,
      tone: 'down',
    }
  }

  if (unhealthy.length > 0) {
    return {
      ...base,
      kind: trackCount > 0 ? 'active-degraded' : 'degraded',
      absenceIsEvidence: false,
      title: 'Coverage degraded',
      detail:
        trackCount > 0
          ? `${describeSensors(unhealthy)} is not reporting, so this picture is incomplete.`
          : `${describeSensors(unhealthy)} is not reporting. An empty map is not evidence of an empty sky.`,
      tone: 'warn',
    }
  }

  if (trackCount > 0) {
    return {
      ...base,
      kind: 'active',
      absenceIsEvidence: true,
      title: trackCount === 1 ? '1 active track' : `${trackCount} active tracks`,
      detail: 'All sensors are reporting.',
      tone: 'ok',
    }
  }

  const detections5m = health.sensors.reduce((sum, s) => sum + (s.detections_5m ?? 0), 0)
  return {
    ...base,
    kind: 'quiet',
    absenceIsEvidence: true,
    title: 'Quiet sky',
    detail:
      detections5m > 0
        ? `All ${healthy.length} sensors are reporting. ${detections5m} detections in the last 5 minutes did not correlate into a track.`
        : `All ${healthy.length} sensors are reporting and have seen nothing for 5 minutes. The empty map means an empty sky.`,
    tone: 'ok',
  }
}

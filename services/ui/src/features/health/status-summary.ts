/**
 * One verdict from four independent facts.
 *
 * The header used to carry a badge each for system health, the live stream,
 * and recording, plus an identity control and a sign-out and a gear and a
 * search. Nine controls competed for one row; on a 360px phone the logo was
 * clipped and none of them were readable. Each was individually justified --
 * and collectively they hid the thing the header exists to show.
 *
 * So the header now asks one question and this answers it: is the system
 * working, and if not, what is the most alarming true thing about it.
 *
 * The ordering is the whole design, and it is not by severity of the word but
 * by what an operator loses:
 *
 *   down      no sensor coverage. Nothing is being detected at all.
 *   paused    detections arrive and are discarded. The box looks alive and
 *             records nothing, which is the failure with no other symptom.
 *   degraded  partial coverage. Some of the sky is unwatched.
 *   stale     the stream is down. The box is fine; this SCREEN is not, and
 *             what is on it may be minutes old.
 *   ok        everything above is false.
 *
 * `stale` last because it is the only one where the detector is fine, and
 * first-among-equals would put a browser's reconnect above a dead radio.
 */
import type { Health, MonitoringState } from '@/lib/api/types'

export type StatusTone = 'ok' | 'warn' | 'down' | 'unknown'

export interface StatusSummary {
  tone: StatusTone
  /** Two words at most: this is rendered on a button at 360px. */
  label: string
  /** One sentence, for the tooltip and the panel heading. */
  detail: string
}

export interface StatusInputs {
  health: Health | undefined
  /** Undefined while it loads; the query is the source for "are we recording". */
  monitoring: MonitoringState | undefined
  connection: 'open' | 'connecting' | 'reconnecting' | 'closed'
  /** True when the health query itself failed — the API is unreachable. */
  healthError?: boolean
}

export function summariseStatus({
  health,
  monitoring,
  connection,
  healthError,
}: StatusInputs): StatusSummary {
  // An unreachable API outranks everything below, because every other input
  // here is a claim this console can no longer check.
  if (healthError) {
    return {
      tone: 'down',
      label: 'No API',
      detail: 'The console cannot reach the API. Nothing on screen is current.',
    }
  }

  if (!health) {
    return {
      tone: 'unknown',
      label: 'Checking',
      detail: 'Waiting for the first health report. Do not read anything into the screen yet.',
    }
  }

  const unhealthy = health.sensors.filter((s) => !s.healthy)

  if (health.status === 'down') {
    return {
      tone: 'down',
      label: 'No coverage',
      detail:
        health.sensors.length === 0
          ? 'No sensors are registered. Nothing on screen is evidence of anything.'
          : `Every sensor is unhealthy (${unhealthy.length} of ${health.sensors.length}). Nothing on screen is evidence of anything.`,
    }
  }

  // Deliberately above `degraded`. A paused recorder is the one failure with
  // no other symptom: sensors are green, the map moves, and nothing is kept.
  if (monitoring && !monitoring.enabled) {
    return {
      tone: 'warn',
      label: 'Paused',
      detail:
        monitoring.discarded_while_paused > 0
          ? `Recording is paused; ${monitoring.discarded_while_paused} detections discarded so far.`
          : 'Recording is paused. Detections are being discarded rather than stored.',
    }
  }

  if (health.status === 'degraded' || unhealthy.length > 0) {
    return {
      tone: 'warn',
      label: unhealthy.length === 1 ? '1 sensor down' : `${unhealthy.length} sensors down`,
      detail: `${unhealthy.length} of ${health.sensors.length} sensors are unhealthy. Part of the sky is unwatched.`,
    }
  }

  if (connection !== 'open') {
    return {
      tone: 'warn',
      label: 'Stale',
      detail:
        connection === 'closed'
          ? 'The live stream is disconnected. The detector is fine; this screen may be minutes old.'
          : 'The live stream is reconnecting. This screen may be a little behind.',
    }
  }

  return {
    tone: 'ok',
    label: 'Healthy',
    detail: `Recording, ${health.sensors.length} sensor${
      health.sensors.length === 1 ? '' : 's'
    } healthy, live stream connected.`,
  }
}

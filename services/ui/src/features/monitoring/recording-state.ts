import type { Health, MonitoringState } from '@/lib/api/types'

/**
 * What the indicator should actually say.
 *
 * The switch being on is not the same as the system recording anything. With
 * every sensor unhealthy, "Recording" is a true statement about a setting and a
 * false statement about the world -- the header would cheerfully claim the sky
 * was being watched while nothing could reach it.
 *
 * That is precisely the failure the health design exists to prevent, so the
 * effective state combines both. Intent alone is never presented as coverage.
 */
export type RecordingState =
  /** Switch on, at least one healthy sensor. Genuinely watching. */
  | 'recording'
  /** Switch on, but nothing is feeding it. Intent without coverage. */
  | 'no-coverage'
  /** Switch on, some sensors healthy and some not. Partial coverage. */
  | 'degraded'
  /** Deliberately stopped. */
  | 'paused'

export function recordingState(
  monitoring: MonitoringState | undefined,
  health: Health | undefined,
): RecordingState | undefined {
  if (!monitoring) return undefined
  if (!monitoring.enabled) return 'paused'
  // Health unknown is not the same as healthy, but claiming no coverage on a
  // failed request would be its own false alarm. Treat it as recording and let
  // the health banner speak for itself.
  if (!health) return 'recording'

  const sensors = health.sensors ?? []
  if (sensors.length === 0) return 'no-coverage'
  const healthy = sensors.filter((s) => s.healthy).length
  if (healthy === 0) return 'no-coverage'
  if (healthy < sensors.length) return 'degraded'
  return 'recording'
}

export const RECORDING_LABEL: Record<RecordingState, string> = {
  recording: 'Recording',
  // Not "Recording": the switch is on but nothing is arriving, and the label
  // has to say what is actually true.
  'no-coverage': 'No coverage',
  degraded: 'Partial coverage',
  paused: 'Paused',
}

export const RECORDING_DESCRIPTION: Record<RecordingState, string> = {
  recording: 'Detections are being recorded.',
  'no-coverage':
    'Recording is on, but every sensor is unhealthy — nothing is reaching it. ' +
    'An empty map right now is evidence of nothing.',
  degraded: 'Recording, but at least one sensor is unhealthy — coverage is incomplete.',
  paused: 'Recording is stopped. Detections are being discarded.',
}

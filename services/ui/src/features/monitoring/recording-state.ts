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

/**
 * The label says what the RECORDER is doing. Coverage is the health pill's job,
 * two chips along in the same header.
 *
 * An earlier version relabelled this chip "No coverage" when sensors were
 * unhealthy, which put the identical words in the header twice and said nothing
 * about whether recording was even on. Tone still carries the warning -- see
 * RECORDING_TONE -- so the chip never looks reassuring without coverage. The
 * fix for "this reads as fine when it isn't" was never to duplicate the other
 * chip's sentence.
 */
export const RECORDING_LABEL: Record<RecordingState, string> = {
  recording: 'Recording',
  'no-coverage': 'Recording',
  degraded: 'Recording',
  paused: 'Paused',
}

/**
 * Only a genuinely covered, genuinely recording system earns the green pulse.
 * Without coverage the chip goes muted rather than red: the red belongs to the
 * health pill, and two alarms for one fact is how a header stops being read.
 */
export const RECORDING_TONE: Record<RecordingState, 'ok' | 'muted' | 'warn'> = {
  recording: 'ok',
  'no-coverage': 'muted',
  degraded: 'muted',
  paused: 'warn',
}

export const RECORDING_DESCRIPTION: Record<RecordingState, string> = {
  recording: 'Detections are being recorded.',
  'no-coverage':
    'Recording is on, but every sensor is unhealthy — nothing is reaching it. ' +
    'An empty map right now is evidence of nothing.',
  degraded: 'Recording, but at least one sensor is unhealthy — coverage is incomplete.',
  paused: 'Recording is stopped. Detections are being discarded.',
}

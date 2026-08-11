/**
 * Turns the live stream into log entries.
 *
 * The hard part is not writing lines, it is *not* writing them. A confirmed
 * drone emits a `track.update` about once a second and fusion may re-emit more
 * often than that; a log that records every frame is a log nobody reads. So the
 * bridge keeps the last observed shape of each track and health record, and
 * only writes when something actually changed.
 *
 * Kept separate from `applyFrame` in the live provider because that function is
 * a pure cache reducer with its own tests, and logging is a side effect that
 * has no business inside it.
 */
import type { Health, ServerFrame, SystemStatus, Track, TrackState } from '@/lib/api/types'
import { log, type LogEntry } from './log-store'

/** The confidence at which a track stops being a hint and starts being a claim. */
const CONFIRM_THRESHOLD = 0.6

type LogDetail = NonNullable<LogEntry['detail']>

interface TrackMemo {
  state: TrackState
  confirmed: boolean
  hadPosition: boolean
}

function trackName(track: Track): string {
  return track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id
}

function evidenceClasses(track: Track): string {
  const classes = (track.evidence ?? []).map((entry) => entry.class)
  return classes.length > 0 ? classes.join('') : '—'
}

export type FrameLogger = (frame: ServerFrame) => void

export function createFrameLogger(): FrameLogger {
  const tracks = new Map<string, TrackMemo>()
  let lastStatus: SystemStatus | null = null
  const sensorHealth = new Map<string, boolean>()
  let lastRecording: boolean | null = null

  const onHealth = (health: Health) => {
    if (lastStatus !== health.status) {
      const previous = lastStatus
      lastStatus = health.status
      if (previous !== null) {
        log.entry({
          level: health.status === 'ok' ? 'info' : health.status === 'down' ? 'error' : 'warn',
          source: 'sensor',
          message: `System status ${previous} → ${health.status}`,
          detail: { sensors: health.sensors.length, version: health.version },
        })
      }
    }

    for (const sensor of health.sensors) {
      const previous = sensorHealth.get(sensor.sensor_id)
      if (previous === sensor.healthy) continue
      sensorHealth.set(sensor.sensor_id, sensor.healthy)
      // The first sighting of a sensor is not a transition; only announce it if
      // it arrives already broken, which IS worth a line.
      if (previous === undefined && sensor.healthy) continue
      log.entry({
        level: sensor.healthy ? 'info' : 'error',
        source: 'sensor',
        message: sensor.healthy
          ? `Sensor ${sensor.sensor_id} recovered`
          : `Sensor ${sensor.sensor_id} unhealthy`,
        detail: {
          kind: sensor.sensor_kind,
          ...(sensor.reason ? { reason: sensor.reason } : {}),
          last_heartbeat: sensor.last_heartbeat,
        },
      })
    }
  }

  return (frame: ServerFrame) => {
    switch (frame.type) {
      case 'track.update': {
        const track = frame.track
        const memo = tracks.get(track.track_id)
        const confirmed = track.confidence >= CONFIRM_THRESHOLD
        const hasPosition = Boolean(track.current)

        if (!memo) {
          tracks.set(track.track_id, {
            state: track.state,
            confirmed,
            hadPosition: hasPosition,
          })
          log.entry({
            level: 'info',
            source: 'track',
            message: `Track opened: ${trackName(track)}`,
            trackId: track.track_id,
            detail: {
              state: track.state,
              confidence: track.confidence.toFixed(2),
              evidence: evidenceClasses(track),
              position: hasPosition ? 'reported' : 'none',
            },
          })
          break
        }

        if (memo.state !== track.state) {
          log.entry({
            level: track.state === 'COASTING' ? 'warn' : 'info',
            source: 'track',
            message: `Track ${trackName(track)}: ${memo.state} → ${track.state}`,
            trackId: track.track_id,
            detail: { confidence: track.confidence.toFixed(2) },
          })
          memo.state = track.state
        }

        if (memo.confirmed !== confirmed) {
          log.entry({
            level: 'info',
            source: 'track',
            message: confirmed
              ? `Track ${trackName(track)} crossed the confirmation threshold`
              : `Track ${trackName(track)} fell below the confirmation threshold`,
            trackId: track.track_id,
            detail: {
              confidence: track.confidence.toFixed(2),
              evidence: evidenceClasses(track),
            },
          })
          memo.confirmed = confirmed
        }

        // A track that stops reporting position vanishes from the map while
        // staying in the table. That discrepancy is worth an explicit line.
        if (memo.hadPosition !== hasPosition) {
          log.entry({
            level: hasPosition ? 'info' : 'warn',
            source: 'track',
            message: hasPosition
              ? `Track ${trackName(track)} started reporting position`
              : `Track ${trackName(track)} stopped reporting position — no longer on the map`,
            trackId: track.track_id,
          })
          memo.hadPosition = hasPosition
        }
        break
      }

      case 'track.closed': {
        const memo = tracks.get(frame.track_id)
        tracks.delete(frame.track_id)
        log.entry({
          level: 'info',
          source: 'track',
          message: `Track closed: ${frame.track_id}`,
          trackId: frame.track_id,
          ...(memo ? { detail: { last_state: memo.state } } : {}),
        })
        break
      }

      case 'detection': {
        const detection = frame.detection
        const detail: LogDetail = { kind: detection.sensor_kind }
        // RSSI lives under `rf`, not at the top level — that is on Detection,
        // whereas Track hoists it. Easy to get backwards.
        const rssi = detection.rf?.rssi_dbm
        if (typeof rssi === 'number') detail.rssi_dbm = rssi
        if (detection.adsb?.icao) detail.icao = detection.adsb.icao
        log.entry({
          level: 'debug',
          source: 'detection',
          message: `Class ${detection.detection_class} detection from ${detection.sensor_id}`,
          detail,
        })
        break
      }

      case 'health':
        onHealth(frame.health)
        break

      case 'monitoring': {
        const { enabled, reason, discarded_while_paused: discarded } = frame.monitoring
        if (lastRecording === enabled) break
        lastRecording = enabled
        log.entry({
          // Not recording is the one state this system exists to avoid being in
          // silently, so it is a warning even though an operator chose it.
          level: enabled ? 'info' : 'warn',
          source: 'ui',
          message: enabled ? 'Recording resumed' : 'Recording paused',
          detail: {
            ...(reason ? { reason } : {}),
            ...(discarded > 0 ? { discarded_while_paused: discarded } : {}),
          },
        })
        break
      }

      case 'capture.status': {
        const capture = frame.capture
        log.entry({
          level: capture.state === 'failed' ? 'error' : 'info',
          source: 'capture',
          message: `Capture ${capture.capture_id} ${capture.state}`,
          detail: {
            iface: capture.iface,
            channel: capture.channel,
            frames: capture.frame_count,
            bytes: capture.size_bytes,
          },
        })
        break
      }

      case 'ping':
        break
    }
  }
}

/** Connection transitions. Separate because they come from the socket, not a frame. */
export function logConnection(state: string, attempt: number): void {
  switch (state) {
    case 'open':
      log.info('stream', 'Live stream connected', { note: 'tracks refetched to close the gap' })
      break
    case 'reconnecting':
      log.warn('stream', `Live stream dropped — reconnecting (attempt ${attempt})`, {
        note: 'positions on screen may be stale',
      })
      break
    case 'closed':
      log.error('stream', 'Live stream closed')
      break
    default:
      break
  }
}

let sessionAnnounced = false

/**
 * Seeds the buffer so an empty log never looks like a broken one.
 *
 * Guarded by a module flag rather than by inspecting the buffer: appends are
 * batched on a timer, so a second call arriving inside the flush window sees an
 * empty snapshot and writes a duplicate. StrictMode's double-invoked effects
 * make that the normal case in development.
 */
export function logSessionStart(): void {
  if (sessionAnnounced) return
  sessionAnnounced = true
  log.entry({
    level: 'info',
    source: 'ui',
    message: 'Console session started',
    detail: { note: 'this log covers this browser session only' },
  })
}

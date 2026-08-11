/**
 * Types for the parts of the API contract that have no JSON Schema.
 *
 * `Track` and `Detection` are GENERATED from `schemas/*.schema.json` — see
 * `schema.gen.ts` and `npm run gen:types`. Everything in this file is transcribed
 * by hand from docs/architecture/api-contract.md, which is normative but not
 * machine-readable. If the contract and this file disagree, the contract wins.
 */
import type { Detection, Position, Track } from './schema.gen'

export type { Detection, Position, Track }

export type DetectionClass = Detection['detection_class']
export type SensorKind = Detection['sensor_kind']
export type TrackState = Track['state']
export type Evidence = NonNullable<Track['evidence']>[number]

// ---------------------------------------------------------------------------
// Health — the most important endpoint in the system.
// ---------------------------------------------------------------------------

/** `ok` all healthy · `degraded` some healthy · `down` none healthy. */
export type SystemStatus = 'ok' | 'degraded' | 'down'

export interface SensorHealth {
  sensor_id: string
  sensor_kind: SensorKind
  healthy: boolean
  last_heartbeat: string
  seconds_since_heartbeat: number
  /**
   * Detections in the last 5 minutes. `0` with `healthy: true` is a quiet sky.
   * `0` with `healthy: false` means the quiet is not evidence of anything.
   *
   * Optional because /sensors is documented as "the sensors array in /health, with
   * full config" and may legitimately omit the rolling counter.
   */
  detections_5m?: number
  /** Present when `healthy` is false. */
  reason?: string
  detail?: Record<string, unknown>
  /** `GET /sensors` returns the same shape "with full config". */
  config?: SensorRuntimeConfig
}

export interface SensorCaptureConfig {
  supported: boolean
  interface?: string
  channel?: number
  duration_s?: number
  label?: string
}

export interface SensorRuntimeConfig {
  unit: string
  stale_after_s: number
  expected: boolean
  restart_command: string
  restart_available: boolean
  restart_unavailable_reason?: string
  capture: SensorCaptureConfig
}

export interface RestartSensorResponse {
  sensor_id: string
  unit: string
  accepted: boolean
}

export interface Health {
  status: SystemStatus
  uptime_s: number
  version: string
  sensors: SensorHealth[]
}

// ---------------------------------------------------------------------------
// Tracks / detections
// ---------------------------------------------------------------------------

export interface TracksResponse {
  tracks: Track[]
  next_cursor: string | null
  total: number
}

export interface DetectionsResponse {
  detections: Detection[]
  next_cursor: string | null
  total: number
}

export interface TracksQuery {
  state?: TrackState[]
  since?: string
  min_confidence?: number
  limit?: number
  cursor?: string
}

export interface DetectionsQuery {
  class?: DetectionClass[]
  sensor_id?: string
  since?: string
  limit?: number
  cursor?: string
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

export type CaptureState = 'running' | 'completed' | 'failed'

export interface CaptureAnalysisSummary {
  analyzed: boolean
  drone_transmitters?: number
  class_a?: number
  class_b?: number
}

export interface Capture {
  capture_id: string
  filename: string
  state: CaptureState
  started_at: string
  ended_at?: string | null
  iface: string
  channel: number
  duration_s: number
  size_bytes: number
  frame_count: number
  analysis?: CaptureAnalysisSummary
}

export interface CapturesResponse {
  captures: Capture[]
}

export interface StartCaptureRequest {
  iface: string
  channel: number
  duration_s: number
  label?: string
}

/**
 * `POST /captures/{id}/analyze` and `GET /captures/{id}/report`.
 *
 * The contract specifies the *content* ("channel usage, measured beacon interval,
 * decoded identities, and the DJI calibration table") but not the field names, so
 * this shape is modelled on `classg_wifi.analyze`'s report — see
 * services/sensor-wifi/classg_wifi/analyze.py. Flagged in ui-design.md as an
 * under-specified part of the contract.
 */
export interface CaptureReport {
  capture_id: string
  frames: number
  beacons: number
  parse_errors: number
  transmitters: number
  /** Drone beacons per channel — the evidence for channels.yaml weights. */
  channel_usage: { channel: number; beacons: number }[]
  beacon_interval?: {
    median_ms: number
    min_ms: number
    max_ms: number
    samples: number
    /** median-derived; the ~1 Hz design assumption is what this tests. */
    rate_hz: number
  } | null
  identities: CaptureIdentity[]
  /**
   * DJI proprietary field calibration. Empty when the aircraft emits no DJI
   * vendor IE, which is the *expected* result for a Mini 5 Pro — see
   * docs/ops/04-calibration.md.
   */
  dji_calibration: DjiCalibrationRow[]
}

export interface CaptureIdentity {
  mac: string
  ssid?: string | null
  serial?: string | null
  id_type?: string | null
  ua_type?: string | null
  manufacturer_code?: string | null
  vendor?: string | null
  protocol_version?: number | null
  odid_count: number
  dji_count: number
  channels: number[]
  rssi_min_dbm?: number | null
  rssi_max_dbm?: number | null
  rssi_median_dbm?: number | null
  /** Whether a System/Operator message carrying operator position was seen. */
  operator_location_broadcast: boolean
}

export interface DjiCalibrationRow {
  field: string
  raw: number | null
  decoded: number | null
  scale: number
  unit: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ChannelPlanEntry {
  channel: number
  freq_mhz: number
  weight: number
}

export interface ChannelPlan {
  channels: ChannelPlanEntry[]
}

/** Fusion confidence weights, keyed by detection class. */
export interface FusionWeights {
  weights: Partial<Record<DetectionClass, number>>
}

export interface ConfigResponse<T> {
  value: T
  restart_required: boolean
}

export interface ConfigPutResponse {
  restart_required: boolean
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'invalid_parameter'
  | 'not_found'
  | 'conflict'
  | 'privileges_required'
  | 'sensor_unavailable'
  | 'internal'

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    field?: string
  }
}

// ---------------------------------------------------------------------------
// Live stream — WS /stream
// ---------------------------------------------------------------------------

export interface SubscribeMessage {
  type: 'subscribe'
  topics: ('tracks' | 'health' | 'detections')[]
}

export interface PongMessage {
  type: 'pong'
}

export type ClientFrame = SubscribeMessage | PongMessage

/**
 * The always-on recording switch.
 *
 * `discarded_while_paused` matters: without it a paused system looks exactly
 * like a quiet sky, which is the confusion the whole health design exists to
 * prevent.
 */
export interface MonitoringState {
  enabled: boolean
  since: string
  reason?: string
  discarded_while_paused: number
}

export type ServerFrame =
  | { type: 'track.update'; ts: string; track: Track }
  | { type: 'track.closed'; ts: string; track_id: string }
  | { type: 'detection'; ts: string; detection: Detection }
  | { type: 'health'; ts: string; health: Health }
  | { type: 'capture.status'; ts: string; capture: Capture }
  | { type: 'monitoring'; ts: string; monitoring: MonitoringState }
  | { type: 'ping'; ts?: string }

export type ServerFrameType = ServerFrame['type']

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
// System — GET /system, behind the About panel
// ---------------------------------------------------------------------------

export interface SystemBuild {
  version: string
  go_version: string
  /** Absent in container builds: .dockerignore excludes .git, so nothing stamps it. */
  revision?: string
  revision_dirty?: boolean
  built_at?: string
}

/** An allowlist on the API side. Turso is a boolean, never its URL or token. */
export interface SystemRuntime {
  listen: string
  store: string
  ui_dir: string
  capture_dir: string
  turso_sync_configured: boolean
  containerised: boolean
}

/**
 * Every reading is nullable and null means "could not be read", with the reason
 * in `unavailable`. Render null as unavailable, never as 0 or a bare dash that
 * reads like data -- 0 °C and an uptime of 0 s are both plausible and both lies.
 */
export interface SystemHost {
  uptime_s: number | null
  load1: number | null
  load5: number | null
  load15: number | null
  cpu_count: number
  cpu_temp_c: number | null
  mem_total_kb: number | null
  mem_available_kb: number | null
  disk_path: string
  disk_total_bytes: number | null
  disk_free_bytes: number | null
  /** field name -> why it is missing. `throttled` is always present here. */
  unavailable?: Record<string, string>
}

export interface SystemInfo {
  build: SystemBuild
  runtime: SystemRuntime
  host: SystemHost
}

// ---------------------------------------------------------------------------
// Telemetry — GET /telemetry, recorded host + sensor history
// ---------------------------------------------------------------------------

export interface TelemetrySensorSample {
  sensor_id: string
  sensor_kind: SensorKind
  healthy: boolean
  metrics?: Record<string, number>
}

/**
 * One recorded minute. Every host figure is nullable and `null` means "the api
 * could not read it" — NOT zero. A chart must draw a gap at a null, never a
 * point at zero and never a line interpolated across the hole: 0 °C and 0 bytes
 * free are both plausible readings. Same rule as `SystemHost`, over time.
 */
export interface TelemetrySample {
  ts: string
  cpu_temp_c: number | null
  load1: number | null
  mem_available_kb: number | null
  disk_free_bytes: number | null
  uptime_s: number | null
  sensors?: TelemetrySensorSample[]
}

export interface TelemetryResponse {
  /** Ascending by time — every consumer is a chart that reads left to right. */
  samples: TelemetrySample[]
  since: string
  until: string
  /**
   * True when the window held more samples than the 5000-sample cap returned.
   * A chart whose axis claims 24 h while showing 6 h of data is a lie, so the
   * API says so rather than leaving it to be inferred.
   */
  truncated: boolean
}

export interface TelemetryQuery {
  /** Go duration, e.g. `6h` (the default) or `90m`. Max `720h`. */
  window?: string
  /** RFC3339; overrides `window`. */
  since?: string
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

/** Where a Tier 2 setting's effective value came from — see ADR-0007. */
export type SettingSource = 'env' | 'db' | 'seed' | 'default'

export interface SettingValue {
  value: unknown
  source: SettingSource
  mutable: boolean
  doc?: string
}

/** `GET /config/settings` — the whole Tier 2 registry, each value with its provenance. */
export interface SettingsResponse {
  settings: Record<string, SettingValue>
  env_overridden: string[]
}

/** Fixed ground position of the receiver, `map.receiver_position` in settings. */
export interface ReceiverPosition {
  lat: number
  lon: number
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

/** The topics the server will filter frames by. See LiveTopic in lib/api/live. */
export type StreamTopic = 'tracks' | 'health' | 'detections' | 'captures' | 'spectrum'

export interface SubscribeMessage {
  type: 'subscribe'
  topics: StreamTopic[]
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
  // The sweep RECORD, never its bins: a completed wideband sweep is over a
  // megabyte of measurement, and the client refetches the trace it wants.
  | { type: 'sweep.status'; ts: string; sweep: SpectrumSweep }
  | { type: 'monitoring'; ts: string; monitoring: MonitoringState }
  | { type: 'ping'; ts?: string }

export type ServerFrameType = ServerFrame['type']

// --- Spectrum -------------------------------------------------------------
//
// Band sweeps from the SDR sensor. ENERGY ONLY: a peak above threshold means
// something is transmitting, never that it is a drone. The detector that could
// tell an ELRS burst train from a smart meter is Milestone 3 and needs a test
// transmitter to validate against, so nothing here carries a classification and
// nothing in the UI may imply one.

export type SweepState = 'running' | 'completed' | 'failed'

export interface SpectrumBand {
  name: string
  class: string
  note: string
  start_hz: number
  stop_hz: number
  steps: number
}

export interface SpectrumBandsResponse {
  bands: SpectrumBand[]
  /** False on a unit with no SDR, or a sensor built without the rtlsdr feature. */
  available: boolean
  /** Why not. Empty when available. */
  reason?: string
  /** Non-empty while the radio is taken by a sweep. */
  running_sweep_id?: string
}

export interface SpectrumSweep {
  sweep_id: string
  band: string
  state: SweepState
  started_at: string
  ended_at?: string
  class?: string
  note?: string
  start_hz?: number
  stop_hz?: number
  steps?: number
  /**
   * Null-able all the way from the api. A sweep that failed has no floor, and
   * substituting 0 dBFS would draw a full-scale signal across the whole band --
   * the loudest possible way to render "we did not measure".
   */
  noise_floor_dbfs?: number | null
  threshold_dbfs?: number | null
  peak_dbfs?: number | null
  peak_hz?: number | null
  /** Steps that read too short to transform, so the band has holes in it. */
  short_reads?: number
  error?: string
}

export interface SpectrumTrace {
  start_hz: number
  stop_hz: number
  bin_width_hz: number
  /**
   * One entry per cell, low frequency to high. **A null is a frequency the
   * receiver could not see, not a quiet one** -- the zero-IF DC guard at every
   * step centre, or a gap between steps. Rendering it as a level draws a
   * measurement that was never taken.
   */
  dbfs: (number | null)[]
  /** How many cells are null. */
  blind: number
}

export interface SpectrumStepPeak {
  center_hz: number
  peak_hz: number | null
  peak_dbfs: number | null
}

export interface SpectrumSweepDetail extends SpectrumSweep {
  /** Absent -- not empty -- while running and on a sweep that failed. */
  trace?: SpectrumTrace
  step_peaks?: SpectrumStepPeak[]
}

export interface SpectrumSweepsResponse {
  sweeps: SpectrumSweep[]
}

export interface StartSweepRequest {
  band: string
}

// --- Auth -----------------------------------------------------------------

/** Ordered: viewer < operator < admin. */
export type Role = 'viewer' | 'operator' | 'admin'

// Indexed by plain string, not by Role, so the undefined checks below are real
// rather than something the compiler proves away. The API is the source of
// truth for what roles exist, and a client that hard-assumes it knows all of
// them would treat a future role as valid by accident.
const ROLE_RANK: Record<string, number | undefined> = {
  viewer: 1,
  operator: 2,
  admin: 3,
}

/**
 * Whether `have` satisfies a requirement for `need`.
 *
 * An unknown role satisfies nothing. This is the client half of the same rule
 * the API enforces — used only to decide what to *draw*, never as the actual
 * gate. Hiding a button is a courtesy; the API refusing the request is the
 * security.
 */
export function roleAtLeast(have: Role | undefined, need: Role): boolean {
  if (!have) return false
  const a = ROLE_RANK[have]
  const b = ROLE_RANK[need]
  return a !== undefined && b !== undefined && a >= b
}

export interface AuthUser {
  user_id: string
  username: string
  display_name?: string
  role: Role
  disabled: boolean
  created_at: string
  updated_at: string
  last_login_at?: string
  /** Non-empty on an SSO account. Such an account has no password. */
  issuer?: string
  subject?: string
}

export interface SsoProvider {
  id: string
  label: string
}

export interface AuthMe {
  authenticated: boolean
  auth_enabled: boolean
  setup_required: boolean
  user?: AuthUser
  providers?: SsoProvider[]
}

export interface LoginRequest {
  username: string
  password: string
}

export interface SetupRequest {
  username: string
  display_name?: string
  password: string
}

export interface CreateUserRequest {
  username: string
  display_name?: string
  password: string
  role: Role
}

export interface UpdateUserRequest {
  role?: Role
  display_name?: string
  disabled?: boolean
  password?: string
}

export interface UsersResponse {
  users: AuthUser[]
}

export interface AuthSession {
  session_id: string
  user_id: string
  username: string
  created_at: string
  expires_at: string
  last_seen: string
  user_agent?: string
  ip?: string
  /** The browser this page is running in. */
  current: boolean
}

export interface SessionsResponse {
  sessions: AuthSession[]
}

// --- Hooks ----------------------------------------------------------------

export type HookEvent =
  | 'track.confirmed'
  | 'track.closed'
  | 'detection.created'
  | 'sensor.unhealthy'
  | 'sensor.recovered'
  | 'capture.completed'
  | 'sweep.completed'

export type HookAction = 'webhook' | 'email'

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'suppressed'

/** The placeholder a write-only secret reads back as. Sending it unchanged on a
 *  PUT means "leave the stored value alone" — see api-contract.md#hooks. */
export const SECRET_PLACEHOLDER = '••••••••'

export interface HookRule {
  rule_id: string
  name: string
  enabled: boolean
  event: HookEvent
  min_confidence?: number
  classes?: string[]
  sensor_kinds?: string[]
  only_drones?: boolean
  /** Per rule AND per subject. Zero from the server means the default. */
  cooldown_s: number
  action: HookAction
  config: Record<string, unknown>
  created_at: string
  updated_at: string
  last_fired_at?: string
  fire_count: number
}

export interface HookEventDoc {
  event: HookEvent
  description: string
}

export interface HookRulesResponse {
  rules: HookRule[]
  events: HookEventDoc[]
  /** False on a unit with no mail server: the UI must not offer an email hook
   *  there and then report the problem only when an alert fails to arrive. */
  smtp_configured: boolean
}

export interface HookDelivery {
  delivery_id: string
  rule_id: string
  rule_name?: string
  event: string
  subject?: string
  status: DeliveryStatus
  attempts: number
  error?: string
  response_code?: number
  created_at: string
  completed_at?: string
}

export interface HookDeliveriesResponse {
  deliveries: HookDelivery[]
  /** Events discarded because the dispatch queue was full. */
  dropped: number
}

export interface TestHookResponse {
  delivered: boolean
  response_code?: number
  error?: string
}

// --- Deployment -----------------------------------------------------------

export interface DeploymentStatus {
  /** False on a dev machine or a unit with no deploy agent. Not an error. */
  configured: boolean
  reason?: string
  commit?: string
  commit_subject?: string
  commit_at?: string
  last_check_at?: string
  last_result?: string
  last_reason?: string
  last_deploy_at?: string
  last_deploy_commit?: string
  last_deploy_ok?: boolean
  remote_commit?: string
  remote_ci?: string
  timer_enabled?: boolean
  update_available: boolean
  deploy_requested: boolean
  /** Seconds since the agent last wrote. Worth more than timer_enabled: a large
   *  age means the agent is not running, whatever the flag says. */
  state_age_s?: number
  /** What the last run made of the things this unit builds for itself.
   *  Absent on runs that deliberately skipped the check, which is why an empty
   *  list and a missing one must not render the same. */
  artefacts?: DeploymentArtefact[]
  log?: string[]
}

export interface DeploymentArtefact {
  name: string
  state: 'current' | 'rebuilt' | 'failed' | 'absent'
}

/** One finished agent run. Only runs that did something are recorded. */
export interface DeploymentRun {
  id: string
  started_at: string
  finished_at: string
  duration_s: number
  result: 'deployed' | 'failed' | 'rebuilt'
  reason?: string
  /** HEAD when the run finished — so a rolled-back run names where it went
   *  back to, not what it tried. `previous_commit` is where it came from. */
  commit?: string
  commit_subject?: string
  previous_commit?: string
  artefacts?: DeploymentArtefact[]
  log?: string[]
}

export interface DeploymentHistory {
  configured: boolean
  reason?: string
  runs: DeploymentRun[]
}

export interface WatchdogStatus {
  configured: boolean
  reason?: string
  last_check_at?: string
  actions_taken: number
  /** Anything the watchdog has stopped trying to repair. The field that matters:
   *  a bounded watchdog's way of telling a person it has given up. */
  needs_hands?: string
  api_healthy: boolean
  wifi_adapter_present: boolean
  sdr_present: boolean
  /** Seconds since the last pass. The timer runs every two minutes, so a large
   *  value means the watchdog itself is not running. */
  state_age_s?: number
  log?: string[]
}

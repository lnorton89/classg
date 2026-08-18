/**
 * MSW request handlers — a complete stand-in for the Go API.
 *
 * The backend is being written concurrently, so this is not a convenience: it is
 * how the app is developed and tested at all. `npm run dev` and `npm test` both
 * work with nothing else running.
 */
import { http, HttpResponse, type PathParams } from 'msw'

import { API_BASE } from '@/lib/api/client'
import type {
  ApiErrorBody,
  AuthMe,
  DeploymentStatus,
  SessionsResponse,
  UsersResponse,
  WatchdogStatus,
  Capture,
  CapturesResponse,
  ChannelPlan,
  ConfigPutResponse,
  ConfigResponse,
  Detection,
  DetectionsResponse,
  FusionWeights,
  Health,
  ReceiverPosition,
  SensorHealth,
  SettingsResponse,
  SettingValue,
  StartCaptureRequest,
  SystemInfo,
  TelemetryResponse,
  Track,
  TracksResponse,
} from '@/lib/api/types'

import { CAPTURES, REPORTS } from './fixtures/captures'
import { channelPlan, fusionWeights } from './fixtures/config'
import { ADSB_DETECTIONS, mini5Detections } from './fixtures/detections'
import { telemetrySamples } from './fixtures/telemetry'
import { getScenario, setScenario, type ScenarioName } from './scenario'

const base = API_BASE

/** Mutable mock state, reset by `resetMockState()` between tests. */
let captures: Capture[] = [...CAPTURES]
let channels: ChannelPlan = structuredClone(channelPlan)
let weights: FusionWeights = structuredClone(fusionWeights)
/** Unconfigured by default, matching config/defaults.yaml. */
let receiverPosition: ReceiverPosition | null = null

/**
 * The external-data settings, so Settings › External data is usable with no
 * backend. Values and docs mirror the Go registry's built-in defaults; the
 * point is that every one of them is off, because "all off by default" is a
 * claim the offline UI should demonstrate rather than assert.
 */
const EXTERNAL_DATA_DEFAULTS: Record<string, string> = {
  'fusion.net_adsb': 'false',
  'fusion.net_adsb_url': 'https://api.adsb.lol',
  'fusion.net_adsb_radius_nm': '25',
  'fusion.net_adsb_interval': '10s',
  'fusion.net_adsb_sensor_id': 'net-adsb-0',
  'fusion.terrain': 'false',
  'fusion.terrain_url': 'https://api.opentopodata.org',
  'fusion.terrain_dataset': 'srtm30m',
  'fusion.terrain_min_interval': '1s',
  'fusion.terrain_geoid_offset_m': '0',
  'fusion.aircraft_db': '',
  'sensors.oui_registry': 'data/ieee-oui.csv',
}

let externalData: Record<string, string> = { ...EXTERNAL_DATA_DEFAULTS }

/** Booleans and numbers arrive typed from the real API, so type them here too. */
function externalDataSettings(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const [key, raw] of Object.entries(externalData)) {
    let value: unknown = raw
    if (raw === 'true' || raw === 'false') value = raw === 'true'
    else if (raw !== '' && !Number.isNaN(Number(raw)) && !key.endsWith('_interval')) {
      value = Number(raw)
    }
    out[key] = { value, source: 'db', mutable: true }
  }
  return out
}
/** Set by tests to force `POST /captures` down the privileges_required path. */
let capturePrivileges = true

export function resetMockState(): void {
  captures = [...CAPTURES]
  channels = structuredClone(channelPlan)
  weights = structuredClone(fusionWeights)
  receiverPosition = null
  externalData = { ...EXTERNAL_DATA_DEFAULTS }
  capturePrivileges = true
}

export function setCapturePrivileges(allowed: boolean): void {
  capturePrivileges = allowed
}

function apiError(
  status: number,
  code: string,
  message: string,
  field?: string,
): HttpResponse<ApiErrorBody> {
  return HttpResponse.json<ApiErrorBody>(
    { error: field ? { code, message, field } : { code, message } },
    { status },
  )
}

function csv(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : []
}

/**
 * The subset of Go duration syntax the telemetry window actually uses:
 * `6h`, `90m`, `1h30m`, `45s`. Returns milliseconds, or null when malformed —
 * the handler turns null into the same invalid_parameter the Go API sends.
 */
function parseGoDuration(raw: string): number | null {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw)
  if (!match || (!match[1] && !match[2] && !match[3])) return null
  const [, h, m, s] = match
  return (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000
}

/** Mirrors the Go API's response cap, so `truncated: true` is reachable in dev. */
const MAX_TELEMETRY_SAMPLES = 5000

// ---------------------------------------------------------------------------

export const handlers = [
  // --- Authentication -----------------------------------------------------
  //
  // Signed in, as an admin, always. Without this the dev server rendered the
  // login screen and nothing behind it -- so every shell change had to be
  // reviewed against a real Pi, and the signed-in header could not be looked
  // at locally at all. The gate itself is exercised by the tests in
  // features/auth, which mock the client directly.
  http.get(`${base}/auth/me`, () =>
    HttpResponse.json<AuthMe>({
      authenticated: true,
      auth_enabled: true,
      setup_required: false,
      user: {
        user_id: 'mock-admin',
        username: 'operator',
        display_name: 'Mock Operator',
        role: 'admin',
        disabled: false,
        created_at: '2026-08-01T09:00:00Z',
        updated_at: '2026-08-01T09:00:00Z',
        last_login_at: '2026-08-11T12:00:00Z',
      },
    }),
  ),
  http.post(`${base}/auth/login`, () => new HttpResponse(null, { status: 204 })),
  http.post(`${base}/auth/logout`, () => new HttpResponse(null, { status: 204 })),

  // --- Administration -----------------------------------------------------
  //
  // Without these the admin page rendered "No accounts", "No active sessions"
  // and "no deploy agent on this unit" in dev -- so every layout decision on
  // the busiest page in the app had to be made against four empty states, or
  // against the real Pi. Populated the way a unit in use looks: two accounts,
  // one of them this browser's, a deploy that landed, a watchdog with nothing
  // to repair, and one hook that has fired.
  http.get(`${base}/admin/users`, () =>
    HttpResponse.json<UsersResponse>({
      users: [
        {
          user_id: 'mock-admin',
          username: 'operator',
          display_name: 'Mock Operator',
          role: 'admin',
          disabled: false,
          created_at: '2026-08-01T09:00:00Z',
          updated_at: '2026-08-01T09:00:00Z',
          last_login_at: '2026-08-11T12:00:00Z',
        },
        {
          user_id: 'mock-viewer',
          username: 'field',
          display_name: 'Field Viewer',
          role: 'viewer',
          disabled: false,
          created_at: '2026-08-05T14:20:00Z',
          updated_at: '2026-08-05T14:20:00Z',
        },
      ],
    }),
  ),

  http.get(`${base}/admin/sessions`, () =>
    HttpResponse.json<SessionsResponse>({
      sessions: [
        {
          session_id: 'mock-session-current',
          user_id: 'mock-admin',
          username: 'operator',
          created_at: '2026-08-11T11:00:00Z',
          expires_at: '2026-08-11T23:00:00Z',
          last_seen: '2026-08-11T12:00:00Z',
          user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          ip: '100.64.0.12',
          current: true,
        },
        {
          session_id: 'mock-session-phone',
          user_id: 'mock-viewer',
          username: 'field',
          created_at: '2026-08-11T08:30:00Z',
          expires_at: '2026-08-11T20:30:00Z',
          last_seen: '2026-08-11T11:55:00Z',
          user_agent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
          ip: '100.64.0.31',
          current: false,
        },
      ],
    }),
  ),
  http.delete(`${base}/admin/sessions/:id`, () => new HttpResponse(null, { status: 204 })),

  // A deploy that landed, on a unit whose agent is running. The interesting
  // states -- "deploying", "blocked", a stale agent -- are reachable by editing
  // this one; they are not the resting state and should not be the default.
  http.get(`${base}/admin/deployment`, () =>
    HttpResponse.json<DeploymentStatus>({
      configured: true,
      commit: '9a234ae9f1c4d7b2a3e5f6081b2c3d4e5f60718a',
      commit_subject: 'Rebuild the header around the two questions it exists to answer',
      commit_at: '2026-08-11T11:40:00Z',
      last_check_at: '2026-08-11T11:58:00Z',
      last_result: 'deployed',
      last_deploy_at: '2026-08-11T11:45:00Z',
      last_deploy_commit: '9a234ae9f1c4d7b2a3e5f6081b2c3d4e5f60718a',
      last_deploy_ok: true,
      remote_commit: '9a234ae9f1c4d7b2a3e5f6081b2c3d4e5f60718a',
      remote_ci: 'success',
      timer_enabled: true,
      update_available: false,
      deploy_requested: false,
      state_age_s: 120,
      log: ['up to date at 9a234ae9'],
    }),
  ),

  http.get(`${base}/admin/watchdog`, () =>
    HttpResponse.json<WatchdogStatus>({
      configured: true,
      last_check_at: '2026-08-11T11:59:00Z',
      actions_taken: 0,
      api_healthy: true,
      wifi_adapter_present: true,
      sdr_present: true,
      state_age_s: 60,
      log: ['nothing to repair'],
    }),
  ),

  // --- Health -------------------------------------------------------------
  http.get(`${base}/health`, () => HttpResponse.json<Health>(getScenario().health)),

  // Modelled on a real reading from the unit, including the shape that matters
  // most: `throttled` is unavailable with a reason rather than absent, because
  // the api runs in a container and cannot reach vcgencmd. Dev and test see the
  // null-with-a-reason path by default, not only the happy one.
  http.get(`${base}/system`, () =>
    HttpResponse.json<SystemInfo>({
      build: { version: '0.1.0', go_version: 'go1.26.6' },
      runtime: {
        listen: ':8081',
        store: 'libsql',
        ui_dir: 'off',
        capture_dir: '/captures',
        turso_sync_configured: false,
        containerised: true,
      },
      host: {
        uptime_s: 12167,
        load1: 0.69,
        load5: 1.32,
        load15: 1.06,
        cpu_count: 4,
        cpu_temp_c: 46.251,
        mem_total_kb: 3887868,
        mem_available_kb: 3409708,
        disk_path: '/data',
        disk_total_bytes: 125585461248,
        disk_free_bytes: 92687323136,
        unavailable: {
          throttled:
            'vcgencmd is not available to the api; run `vcgencmd get_throttled` on the Pi',
        },
      },
    }),
  ),

  // Recorded host history. The fixture guarantees null readings and a sampler
  // outage inside the default 6 h window, so the charts' gap path runs in dev
  // and test by default — see fixtures/telemetry.ts. Ascending, capped at 5000
  // samples with `truncated` set, exactly like the Go handler.
  // Like /tracks below, the body type is stated explicitly because the
  // resolver can return either the history or the error envelope.
  http.get<PathParams, never, TelemetryResponse | ApiErrorBody>(
    `${base}/telemetry`,
    ({ request }) => {
      const url = new URL(request.url)
      const until = Date.now()

      let windowMs = 6 * 3600 * 1000
      const rawWindow = url.searchParams.get('window')
      if (rawWindow) {
        const parsed = parseGoDuration(rawWindow)
        if (parsed === null || parsed <= 0) {
          return apiError(
            400,
            'invalid_parameter',
            'must be a positive duration, for example 6h or 90m',
            'window',
          )
        }
        if (parsed > 720 * 3600 * 1000) {
          return apiError(400, 'invalid_parameter', 'must be at most 720h', 'window')
        }
        windowMs = parsed
      }

      let since = until - windowMs
      const rawSince = url.searchParams.get('since')
      if (rawSince) {
        const parsed = Date.parse(rawSince)
        if (Number.isNaN(parsed)) {
          return apiError(400, 'invalid_parameter', 'must be RFC3339', 'since')
        }
        since = parsed
      }
      if (since > until) {
        return apiError(400, 'invalid_parameter', 'must be before now', 'since')
      }

      let samples = telemetrySamples(since, until)
      const truncated = samples.length > MAX_TELEMETRY_SAMPLES
      if (truncated) samples = samples.slice(0, MAX_TELEMETRY_SAMPLES)

      return HttpResponse.json<TelemetryResponse>({
        samples,
        since: new Date(since).toISOString(),
        until: new Date(until).toISOString(),
        truncated,
      })
    },
  ),

  http.get(`${base}/sensors`, () =>
    HttpResponse.json<{ sensors: SensorHealth[] }>({
      sensors: getScenario().health.sensors.map((sensor) => ({
        ...sensor,
        config: {
          unit: `classg-sensor-${sensor.sensor_kind}.service`,
          stale_after_s: 30,
          expected: true,
          restart_command: `systemctl restart classg-sensor-${sensor.sensor_kind}.service`,
          restart_available: true,
          capture:
            sensor.sensor_kind === 'wifi'
              ? {
                  supported: true,
                  interface: 'wlan0',
                  channel: 6,
                  duration_s: 120,
                  label: 'sensor-capture',
                }
              : { supported: false },
        },
      })),
    }),
  ),

  http.post<PathParams<'id'>>(`${base}/sensors/:id/restart`, ({ params }) => {
    const exists = getScenario().health.sensors.some((s) => s.sensor_id === params.id)
    if (!exists) return apiError(404, 'not_found', `no such sensor: ${String(params.id)}`)
    return HttpResponse.json(
      {
        sensor_id: String(params.id),
        unit: 'classg-sensor-wifi.service',
        accepted: true,
      },
      { status: 202 },
    )
  }),

  // --- Tracks -------------------------------------------------------------
  // The response type is stated explicitly because this resolver can return
  // either a page of tracks or the error envelope, and MSW otherwise infers the
  // body type from whichever branch it sees first.
  http.get<PathParams, never, TracksResponse | ApiErrorBody>(
    `${base}/tracks`,
    ({ request }) => {
      const url = new URL(request.url)
      const states = csv(url.searchParams.get('state'))
      const minConfidence = Number(url.searchParams.get('min_confidence') ?? '0')
      const since = url.searchParams.get('since')
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam === null ? 100 : Number(limitParam)

      if (Number.isNaN(limit) || limit > 1000) {
        return apiError(400, 'invalid_parameter', 'limit must be <= 1000', 'limit')
      }

      let tracks: Track[] = getScenario().tracks
      if (states.length > 0) tracks = tracks.filter((t) => states.includes(t.state))
      if (minConfidence > 0) tracks = tracks.filter((t) => t.confidence >= minConfidence)
      if (since) {
        const cutoff = Date.parse(since)
        if (!Number.isNaN(cutoff)) {
          tracks = tracks.filter((t) => Date.parse(t.last_seen) >= cutoff)
        }
      }

      return HttpResponse.json<TracksResponse>({
        tracks: tracks.slice(0, limit),
        next_cursor: null,
        total: tracks.length,
      })
    },
  ),

  http.get<PathParams<'trackId'>>(`${base}/tracks/:trackId`, ({ params }) => {
    const track = getScenario().tracks.find((t) => t.track_id === params.trackId)
    if (!track) return apiError(404, 'not_found', `no such track: ${String(params.trackId)}`)
    return HttpResponse.json<Track>(track)
  }),

  http.get<PathParams<'trackId'>>(
    `${base}/tracks/:trackId/detections`,
    ({ params, request }) => {
      const track = getScenario().tracks.find((t) => t.track_id === params.trackId)
      if (!track) return apiError(404, 'not_found', `no such track: ${String(params.trackId)}`)
      const limit = Number(new URL(request.url).searchParams.get('limit') ?? '100')
      const serial = track.identity?.serial
      // Only the Mini 5 Pro fixture has a detection corpus; others report the count
      // they claim without inventing per-detection detail.
      const detections =
        serial === '1581F5NCC2400A7YZ12K' ? mini5Detections(Math.min(limit, 120)) : []
      return HttpResponse.json<DetectionsResponse>({
        detections,
        next_cursor: null,
        total: detections.length,
      })
    },
  ),

  // --- Detections ---------------------------------------------------------
  http.get(`${base}/detections`, ({ request }) => {
    const url = new URL(request.url)
    const classes = csv(url.searchParams.get('class'))
    const sensorId = url.searchParams.get('sensor_id')
    const limit = Number(url.searchParams.get('limit') ?? '100')

    let detections: Detection[] = [...ADSB_DETECTIONS, ...mini5Detections(40)]
    // With no healthy SDR there is no ADS-B, which is the point: a broken sensor
    // means an absence of data, not an absence of aircraft.
    const sdrHealthy = getScenario().health.sensors.some(
      (s) => s.sensor_kind === 'sdr' && s.healthy,
    )
    if (!sdrHealthy) detections = detections.filter((d) => d.sensor_kind !== 'sdr')
    if (getScenario().tracks.length === 0) {
      detections = detections.filter((d) => d.detection_class === 'D')
    }
    if (classes.length > 0) {
      detections = detections.filter((d) => classes.includes(d.detection_class))
    }
    if (sensorId) detections = detections.filter((d) => d.sensor_id === sensorId)

    detections = detections
      .slice()
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, limit)

    return HttpResponse.json<DetectionsResponse>({
      detections,
      next_cursor: null,
      total: detections.length,
    })
  }),

  // --- Captures -----------------------------------------------------------
  http.get(`${base}/captures`, () => HttpResponse.json<CapturesResponse>({ captures })),

  http.post<PathParams, StartCaptureRequest>(`${base}/captures`, async ({ request }) => {
    if (!capturePrivileges) {
      return apiError(
        503,
        'privileges_required',
        'monitor mode requires elevated privileges; run the API with CAP_NET_ADMIN or as root',
      )
    }
    const body = await request.json()
    if (!body.iface) {
      return apiError(400, 'invalid_parameter', 'iface is required', 'iface')
    }
    if (body.duration_s <= 0 || body.duration_s > 3600) {
      return apiError(
        400,
        'invalid_parameter',
        'duration_s must be between 1 and 3600',
        'duration_s',
      )
    }
    const now = new Date().toISOString()
    const capture: Capture = {
      capture_id: `01J${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(23, '0')}`,
      filename: `${now.slice(0, 10)}-${body.label ?? 'capture'}.pcap`,
      state: 'running',
      started_at: now,
      ended_at: null,
      iface: body.iface,
      channel: body.channel,
      duration_s: body.duration_s,
      size_bytes: 0,
      frame_count: 0,
    }
    captures = [capture, ...captures]
    return HttpResponse.json<Capture>(capture, { status: 202 })
  }),

  http.get<PathParams<'id'>>(`${base}/captures/:id`, ({ params }) => {
    const capture = captures.find((c) => c.capture_id === params.id)
    if (!capture) return apiError(404, 'not_found', `no such capture: ${String(params.id)}`)
    return HttpResponse.json<Capture>(capture)
  }),

  http.post<PathParams<'id'>>(`${base}/captures/:id/stop`, ({ params }) => {
    const index = captures.findIndex((c) => c.capture_id === params.id)
    const existing = index === -1 ? undefined : captures[index]
    if (!existing) return apiError(404, 'not_found', `no such capture: ${String(params.id)}`)
    if (existing.state !== 'running') {
      return apiError(409, 'conflict', `capture is ${existing.state}, not running`)
    }
    const stopped: Capture = {
      ...existing,
      state: 'completed',
      ended_at: new Date().toISOString(),
      size_bytes: 128_004,
      frame_count: 517,
    }
    captures = captures.map((c, i) => (i === index ? stopped : c))
    return HttpResponse.json<Capture>(stopped)
  }),

  http.post<PathParams<'id'>>(`${base}/captures/:id/analyze`, ({ params }) => {
    const report = REPORTS[String(params.id)]
    if (!report) {
      return apiError(404, 'not_found', `no analysis available for ${String(params.id)}`)
    }
    captures = captures.map((c) =>
      c.capture_id === params.id
        ? {
            ...c,
            analysis: {
              analyzed: true,
              drone_transmitters: report.identities.length,
              class_a: report.identities.reduce((n, i) => n + i.odid_count, 0),
              class_b: report.identities.reduce((n, i) => n + i.dji_count, 0),
            },
          }
        : c,
    )
    return HttpResponse.json(report)
  }),

  http.get<PathParams<'id'>>(`${base}/captures/:id/report`, ({ params }) => {
    const report = REPORTS[String(params.id)]
    if (!report) {
      return apiError(404, 'not_found', `capture ${String(params.id)} has not been analyzed`)
    }
    return HttpResponse.json(report)
  }),

  /**
   * Raw PCAP download. Streams bytes, so the mock returns a tiny but genuinely
   * valid libpcap file header rather than JSON — enough that a download in dev
   * produces a file Wireshark will open instead of a corrupt stub.
   */
  http.get<PathParams<'id'>>(`${base}/captures/:id/download`, ({ params }) => {
    const capture = captures.find((c) => c.capture_id === params.id)
    if (!capture) return apiError(404, 'not_found', `no such capture: ${String(params.id)}`)
    if (capture.state === 'running') {
      return apiError(409, 'conflict', 'capture is still running')
    }
    // libpcap global header: magic, v2.4, no tz/sigfigs, snaplen 262144,
    // linktype 127 (LINKTYPE_IEEE802_11_RADIOTAP).
    const header = new Uint8Array([
      0xd4, 0xc3, 0xb2, 0xa1, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x04, 0x00, 0x7f, 0x00, 0x00, 0x00,
    ])
    return new HttpResponse(header, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.tcpdump.pcap',
        'Content-Disposition': `attachment; filename="${capture.filename}"`,
      },
    })
  }),

  // --- Config -------------------------------------------------------------
  http.get(`${base}/config/channels`, () =>
    HttpResponse.json<ConfigResponse<ChannelPlan>>({
      value: channels,
      restart_required: false,
    }),
  ),

  http.put<PathParams, ChannelPlan>(`${base}/config/channels`, async ({ request }) => {
    const body = await request.json()
    if (!Array.isArray(body.channels) || body.channels.length === 0) {
      return apiError(400, 'invalid_parameter', 'at least one channel is required', 'channels')
    }
    const bad = body.channels.find((c) => c.weight < 0)
    if (bad) {
      return apiError(
        400,
        'invalid_parameter',
        `weight for channel ${bad.channel} must be >= 0`,
        'weight',
      )
    }
    channels = body
    return HttpResponse.json<ConfigResponse<ChannelPlan>>({
      value: channels,
      restart_required: false,
    })
  }),

  http.get(`${base}/config/weights`, () =>
    HttpResponse.json<ConfigResponse<FusionWeights>>({
      value: weights,
      restart_required: false,
    }),
  ),

  http.put<PathParams, FusionWeights>(`${base}/config/weights`, async ({ request }) => {
    const body = await request.json()
    for (const [cls, weight] of Object.entries(body.weights)) {
      if (weight < 0 || weight > 1) {
        return apiError(
          400,
          'invalid_parameter',
          `weight for class ${cls} must be between 0 and 1`,
          cls,
        )
      }
    }
    weights = body
    return HttpResponse.json<ConfigResponse<FusionWeights>>({
      value: weights,
      restart_required: false,
    })
  }),

  /**
   * Generic Tier 2 settings (ADR-0007). Only the keys the UI actually reads
   * are represented — a mock does not need to mirror the full Go registry.
   */
  http.get(`${base}/config/settings`, () =>
    HttpResponse.json<SettingsResponse>({
      settings: {
        'map.receiver_position': {
          value: receiverPosition,
          source: 'db',
          mutable: true,
          doc: 'lat,lon of the receiver; centres the map before any track exists',
        },
        ...externalDataSettings(),
      },
      env_overridden: [],
    }),
  ),

  http.put<PathParams, Record<string, string>>(
    `${base}/config/settings`,
    async ({ request }) => {
      const body = await request.json()
      const raw = body['map.receiver_position']
      if (raw !== undefined) {
        if (raw.trim() === '') {
          receiverPosition = null
        } else {
          const [lat, lon] = raw.split(',').map(Number)
          if (
            lat === undefined ||
            lon === undefined ||
            Number.isNaN(lat) ||
            Number.isNaN(lon)
          ) {
            return apiError(
              400,
              'invalid_parameter',
              `${raw} is not lat,lon`,
              'map.receiver_position',
            )
          }
          receiverPosition = { lat, lon }
        }
      }
      for (const [key, value] of Object.entries(body)) {
        if (key in externalData) externalData[key] = value
      }
      return HttpResponse.json<ConfigPutResponse>({ restart_required: false })
    },
  ),

  // --- Mock control (dev only, never part of the real API) -----------------
  http.post<PathParams, { scenario: ScenarioName }>('/__mock/scenario', async ({ request }) => {
    const body = await request.json()
    setScenario(body.scenario)
    return HttpResponse.json({ scenario: body.scenario })
  }),
]

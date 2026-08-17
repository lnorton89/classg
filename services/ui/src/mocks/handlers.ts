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
  Track,
  TracksResponse,
} from '@/lib/api/types'

import { CAPTURES, REPORTS } from './fixtures/captures'
import { channelPlan, fusionWeights } from './fixtures/config'
import { ADSB_DETECTIONS, mini5Detections } from './fixtures/detections'
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

// ---------------------------------------------------------------------------

export const handlers = [
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

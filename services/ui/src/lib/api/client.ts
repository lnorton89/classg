/**
 * Thin fetch wrapper over the ClassG API.
 *
 * Two responsibilities beyond `fetch`:
 *   1. Turn the uniform error envelope into a typed `ApiError`, so every caller
 *      gets `code`/`field` instead of parsing bodies at each call site.
 *   2. Normalise two known shape divergences between the JSON Schema and the Go
 *      structs (see `normalizeTrack`). Being liberal here is deliberate: the
 *      backend is being written concurrently, and a UI that hard-fails on an
 *      evidence map instead of an evidence array is a bad trade.
 */
import type {
  ApiErrorBody,
  Capture,
  CaptureReport,
  CapturesResponse,
  ChannelPlan,
  ConfigPutResponse,
  ConfigResponse,
  DetectionsQuery,
  DetectionsResponse,
  Evidence,
  FusionWeights,
  Health,
  RestartSensorResponse,
  SensorHealth,
  StartCaptureRequest,
  Track,
  TracksQuery,
  TracksResponse,
  MonitoringState,
} from './types'

export const API_BASE: string =
  (import.meta.env['VITE_API_BASE'] as string | undefined) ?? '/api/v1'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field: string | undefined

  constructor(status: number, code: string, message: string, field?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
  }

  /** `POST /captures` returns this when it cannot get monitor-mode privileges. */
  get isPrivilegesRequired(): boolean {
    return this.code === 'privileges_required'
  }

  get isNotFound(): boolean {
    return this.code === 'not_found' || this.status === 404
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const err = (value as { error?: unknown }).error
  return typeof err === 'object' && err !== null && 'message' in err
}

function buildQuery(params: Record<string, string | number | undefined | string[]>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','))
    } else {
      search.set(key, String(value))
    }
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      /* a non-JSON error body is still an error */
    }
    if (isApiErrorBody(body)) {
      throw new ApiError(response.status, body.error.code, body.error.message, body.error.field)
    }
    throw new ApiError(response.status, 'internal', `${response.status} ${response.statusText}`)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * `schemas/track.schema.json` declares `evidence` as an ARRAY. The Go fusion
 * struct (services/fusion/track.go) declares it as `map[string]*Evidence`, which
 * serialises to an object keyed by class. The schema is normative, so the array
 * is what we expect — but accepting both costs eight lines and removes an entire
 * class of "the UI is blank" bug during concurrent development.
 *
 * Flagged in docs/architecture/ui-design.md as a contract discrepancy to resolve.
 */
function normalizeEvidence(value: unknown): Evidence[] {
  if (Array.isArray(value)) return value as Evidence[]
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, Evidence>).filter(Boolean)
  }
  return []
}

export function normalizeTrack(raw: Track): Track {
  const withSuppression = raw as Track & {
    suppression?: { adsb_correlated?: boolean; adsb_icao?: string | null }
  }
  return {
    ...raw,
    evidence: normalizeEvidence(raw.evidence),
    history: raw.history ?? [],
    // data-model.md nests this under `suppression`; the schema has it at the top
    // level. Prefer the schema, fall back to the doc's shape.
    adsb_correlated:
      raw.adsb_correlated ?? withSuppression.suppression?.adsb_correlated ?? false,
  }
}

/**
 * Config endpoints return an envelope so PUT can report whether another
 * service must restart. Accept the direct shape as well for compatibility with
 * older API builds, but keep the unwrap at the transport boundary so views
 * never have to know about both representations.
 */
export function unwrapConfigValue<T>(response: ConfigResponse<T> | T): T {
  if (typeof response === 'object' && response !== null && 'value' in response) {
    return response.value
  }
  return response
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  health(): Promise<Health> {
    return request<Health>('/health')
  },

  monitoring(): Promise<MonitoringState> {
    return request<MonitoringState>('/monitoring')
  },

  setMonitoring(enabled: boolean, reason?: string): Promise<MonitoringState> {
    return request<MonitoringState>('/monitoring', {
      method: 'PUT',
      body: JSON.stringify({ enabled, reason }),
    })
  },

  sensors(): Promise<SensorHealth[]> {
    return request<{ sensors: SensorHealth[] } | SensorHealth[]>('/sensors').then((r) =>
      Array.isArray(r) ? r : r.sensors,
    )
  },

  restartSensor(sensorId: string): Promise<RestartSensorResponse> {
    return request<RestartSensorResponse>(`/sensors/${encodeURIComponent(sensorId)}/restart`, {
      method: 'POST',
    })
  },

  async tracks(query: TracksQuery = {}): Promise<TracksResponse> {
    const res = await request<TracksResponse>(
      `/tracks${buildQuery({
        state: query.state ?? [],
        since: query.since,
        min_confidence: query.min_confidence,
        limit: query.limit,
        cursor: query.cursor,
      })}`,
    )
    return { ...res, tracks: res.tracks.map(normalizeTrack) }
  },

  async track(trackId: string): Promise<Track> {
    return normalizeTrack(await request<Track>(`/tracks/${encodeURIComponent(trackId)}`))
  },

  trackDetections(trackId: string, query: DetectionsQuery = {}): Promise<DetectionsResponse> {
    return request<DetectionsResponse>(
      `/tracks/${encodeURIComponent(trackId)}/detections${buildQuery({
        since: query.since,
        limit: query.limit,
        cursor: query.cursor,
      })}`,
    )
  },

  detections(query: DetectionsQuery = {}): Promise<DetectionsResponse> {
    return request<DetectionsResponse>(
      `/detections${buildQuery({
        class: query.class ?? [],
        sensor_id: query.sensor_id,
        since: query.since,
        limit: query.limit,
        cursor: query.cursor,
      })}`,
    )
  },

  captures(): Promise<CapturesResponse> {
    return request<CapturesResponse>('/captures')
  },

  capture(captureId: string): Promise<Capture> {
    return request<Capture>(`/captures/${encodeURIComponent(captureId)}`)
  },

  startCapture(body: StartCaptureRequest): Promise<Capture> {
    return request<Capture>('/captures', { method: 'POST', body: JSON.stringify(body) })
  },

  stopCapture(captureId: string): Promise<Capture> {
    return request<Capture>(`/captures/${encodeURIComponent(captureId)}/stop`, {
      method: 'POST',
    })
  },

  analyzeCapture(captureId: string): Promise<CaptureReport> {
    return request<CaptureReport>(`/captures/${encodeURIComponent(captureId)}/analyze`, {
      method: 'POST',
    })
  },

  captureReport(captureId: string): Promise<CaptureReport> {
    return request<CaptureReport>(`/captures/${encodeURIComponent(captureId)}/report`)
  },

  /**
   * URL for `GET /captures/{id}/download` (raw .pcap).
   *
   * Returned as a URL rather than a fetch so the browser streams it straight to
   * disk — a capture can be large, and buffering it through JS to make a blob is
   * pointless. Note that api-contract.md currently says the opposite ("Never
   * expose raw PCAP download over the API"); see ui-design.md.
   */
  captureDownloadUrl(captureId: string): string {
    return `${API_BASE}/captures/${encodeURIComponent(captureId)}/download`
  },

  channelPlan(): Promise<ChannelPlan> {
    return request<ConfigResponse<ChannelPlan> | ChannelPlan>('/config/channels').then(
      unwrapConfigValue,
    )
  },

  putChannelPlan(body: ChannelPlan): Promise<ConfigPutResponse> {
    return request<ConfigPutResponse>('/config/channels', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  weights(): Promise<FusionWeights> {
    return request<ConfigResponse<FusionWeights> | FusionWeights>('/config/weights').then(
      unwrapConfigValue,
    )
  },

  putWeights(body: FusionWeights): Promise<ConfigPutResponse> {
    return request<ConfigPutResponse>('/config/weights', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },
}

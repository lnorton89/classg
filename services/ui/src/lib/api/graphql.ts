/**
 * The one GraphQL query this UI issues, against POST /api/v1/graphql
 * (services/api/internal/graphqlapi).
 *
 * It exists for exactly the case the endpoint was built to answer: a track's
 * detail page needs the track AND the detections that fed it, which over REST
 * is `GET /tracks/{id}` plus `GET /tracks/{id}/detections` -- two round trips
 * on a link that is often a phone tethered to the unit's own access point.
 * `track(track_id) { ... detections { ... } }` asks for both in one.
 *
 * `raw` is not requested: the schema deliberately has no resolver for it (see
 * graphqlapi/types.go), so the detail page's detections carry every field
 * REST does except the vendor IE bytes -- unused here regardless.
 */
import { ApiError, request } from './client'
import type { Detection, DetectionsResponse, Track } from './types'

interface GraphQLResponse<T> {
  data?: T
  errors?: { message: string }[]
}

async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  // The endpoint is always HTTP 200, success or failure -- that is the
  // GraphQL contract, not REST's error envelope, so failures are read from
  // `errors` rather than from `request`'s usual ApiError-on-!ok path.
  const result = await request<GraphQLResponse<T>>('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  })
  if (result.errors?.length) {
    throw new ApiError(200, 'internal', result.errors.map((e) => e.message).join('; '))
  }
  if (result.data === undefined) {
    throw new ApiError(200, 'internal', 'GraphQL response carried no data')
  }
  return result.data
}

const TRACK_WITH_DETECTIONS_QUERY = `
  query TrackWithDetections($trackId: ID!, $limit: Int) {
    track(track_id: $trackId) {
      schema_version track_id state first_seen last_seen detection_count
      confidence rssi_dbm adsb_correlated
      identity { serial macs vendor manufacturer_code model_hint operator_id ua_type }
      evidence { class sensor_kind weight count last_seen }
      current { lat lon alt_geodetic_m height_agl_m speed_mps track_deg at }
      history { lat lon alt_geodetic_m height_agl_m speed_mps track_deg at }
      operator { lat lon alt_m at }
      detections(limit: $limit) {
        detections {
          schema_version detection_id ts sensor_id sensor_kind detection_class
          rf { freq_hz channel rssi_dbm bandwidth_hz snr_db }
          identity { serial mac id_type ua_type operator_id self_id vendor_hint }
          position { lat lon alt_geodetic_m height_agl_m }
          kinematics { speed_mps track_deg vertical_speed_mps }
          operator { lat lon alt_m }
          signal_features {
            burst_rate_hz burst_duration_us duty_cycle hop_count occupied_bw_hz protocol_hint
          }
          adsb { icao callsign alt_ft ground_speed_kt }
        }
        next_cursor
        total
      }
    }
  }
`

// Raw shapes as they arrive over the wire: the Hz scalar is a decimal STRING
// (graphqlapi/types.go -- GraphQL's Int is 32-bit and 2.4 GHz does not fit),
// and OperatorPosition carries `alt_m`, not the aircraft position's
// `alt_geodetic_m`. mapTrack/mapDetection below convert both into the same
// shapes REST returns, so nothing downstream of the API client can tell which
// transport a track came from.
interface GqlPosition {
  lat: number
  lon: number
  alt_geodetic_m: number | null
  height_agl_m: number | null
  speed_mps: number | null
  track_deg: number | null
  at: string | null
}
interface GqlOperatorPosition {
  lat: number
  lon: number
  alt_m: number | null
  at: string | null
}
interface GqlTrack {
  schema_version: string | null
  track_id: string
  state: Track['state']
  first_seen: string
  last_seen: string
  detection_count: number
  confidence: number
  rssi_dbm: number | null
  adsb_correlated: boolean
  identity: NonNullable<Track['identity']> | null
  evidence: NonNullable<Track['evidence']> | null
  current: GqlPosition | null
  history: GqlPosition[] | null
  operator: GqlOperatorPosition | null
  detections: GqlDetectionPage
}
interface GqlDetection {
  schema_version: string | null
  detection_id: string
  ts: string
  sensor_id: string
  sensor_kind: Detection['sensor_kind']
  detection_class: Detection['detection_class']
  rf: {
    freq_hz: string | null
    channel: number | null
    rssi_dbm: number | null
    bandwidth_hz: string | null
    snr_db: number | null
  } | null
  identity: NonNullable<Detection['identity']> | null
  position:
    | (Omit<NonNullable<Detection['position']>, 'alt_pressure_m'> & { alt_pressure_m?: never })
    | null
  kinematics: Detection['kinematics'] | null
  operator: GqlOperatorPosition | null
  signal_features:
    | (Omit<NonNullable<Detection['signal_features']>, 'occupied_bw_hz'> & {
        occupied_bw_hz: string | null
      })
    | null
  adsb: Detection['adsb'] | null
}
interface GqlDetectionPage {
  detections: GqlDetection[]
  next_cursor: string | null
  total: number | null
}

/** Hz arrives as a decimal string; REST's field is a plain number. */
function parseHz(value: string | null | undefined): number | undefined {
  if (value == null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function mapPosition(p: GqlPosition): NonNullable<Track['current']> {
  return {
    lat: p.lat,
    lon: p.lon,
    alt_geodetic_m: p.alt_geodetic_m,
    height_agl_m: p.height_agl_m,
    speed_mps: p.speed_mps,
    track_deg: p.track_deg,
    at: p.at ?? undefined,
  }
}

/**
 * Track.operator only carries `{lat, lon, alt_m, at}` over GraphQL -- the
 * same restricted shape the Go model and the REST wire format actually send
 * (model.OperatorPosition), even though track.schema.json still documents the
 * full position shape for it. This maps to what is genuinely on the wire
 * rather than inventing an `alt_geodetic_m` the API never sends, so the field
 * is simply absent here exactly as it already is over REST.
 */
function mapOperator(o: GqlOperatorPosition | null): Track['operator'] {
  if (!o) return null
  return { lat: o.lat, lon: o.lon, at: o.at ?? undefined }
}

function mapDetection(d: GqlDetection): Detection {
  return {
    schema_version: '1.0',
    detection_id: d.detection_id,
    ts: d.ts,
    sensor_id: d.sensor_id,
    sensor_kind: d.sensor_kind,
    detection_class: d.detection_class,
    rf: d.rf
      ? {
          freq_hz: parseHz(d.rf.freq_hz),
          channel: d.rf.channel,
          rssi_dbm: d.rf.rssi_dbm,
          bandwidth_hz: parseHz(d.rf.bandwidth_hz) ?? null,
          snr_db: d.rf.snr_db,
        }
      : undefined,
    identity: d.identity ?? undefined,
    position: d.position,
    kinematics: d.kinematics,
    operator: d.operator
      ? { lat: d.operator.lat, lon: d.operator.lon, alt_m: d.operator.alt_m }
      : null,
    signal_features: d.signal_features
      ? {
          ...d.signal_features,
          occupied_bw_hz: parseHz(d.signal_features.occupied_bw_hz) ?? null,
        }
      : null,
    adsb: d.adsb,
  }
}

function mapTrack(t: GqlTrack): Track {
  return {
    schema_version: '1.0',
    track_id: t.track_id,
    state: t.state,
    first_seen: t.first_seen,
    last_seen: t.last_seen,
    detection_count: t.detection_count,
    identity: t.identity ?? undefined,
    confidence: t.confidence,
    evidence: t.evidence ?? [],
    current: t.current ? mapPosition(t.current) : undefined,
    history: (t.history ?? []).map(mapPosition),
    operator: mapOperator(t.operator),
    rssi_dbm: t.rssi_dbm,
    adsb_correlated: t.adsb_correlated,
  }
}

/**
 * One track and the detections that fed it, in one round trip.
 *
 * Throws the same `ApiError.isNotFound` shape `api.track()` does, even though
 * GraphQL itself answers a missing id with a null field rather than an error
 * (graphqlapi/resolvers.go) -- callers such as the tracks/$trackId route
 * loader already handle REST's not-found convention, and a second convention
 * for the same case is not something they should need to know about.
 */
export async function trackWithDetections(
  trackId: string,
  limit = 500,
): Promise<{ track: Track; detections: DetectionsResponse }> {
  const data = await graphqlRequest<{ track: GqlTrack | null }>(TRACK_WITH_DETECTIONS_QUERY, {
    trackId,
    limit,
  })
  if (!data.track) {
    throw new ApiError(404, 'not_found', `no track with id ${trackId}`)
  }
  const detections: DetectionsResponse = {
    detections: data.track.detections.detections.map(mapDetection),
    next_cursor: data.track.detections.next_cursor,
    total: data.track.detections.total ?? data.track.detections.detections.length,
  }
  return { track: mapTrack(data.track), detections }
}

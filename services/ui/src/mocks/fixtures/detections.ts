/**
 * Detection fixtures.
 *
 * Class D (ADS-B) is the important set: manned traffic must be visible on the map
 * and must never be mistaken for a drone. The contract has no ADS-B endpoint, so
 * class D detections are how manned traffic reaches the UI.
 */
import type { Detection } from '@/lib/api/types'

import { isoAt, offsetLatLon, SITE } from './site'

function ulid(seed: string): string {
  // Fixtures need to satisfy the schema's ULID pattern: 26 chars, Crockford
  // base32 (no I, L, O, U). Deterministic so snapshots are stable.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  let out = ''
  for (let i = 0; i < 26; i += 1) {
    hash = (hash * 1103515245 + 12345) >>> 0
    out += alphabet[hash % 32]
  }
  return out
}

const helicopterPos = offsetLatLon(SITE.lat, SITE.lon, 1450, 900)
const airlinerPos = offsetLatLon(SITE.lat, SITE.lon, -3600, 5200)

export const adsbHelicopter: Detection = {
  schema_version: '1.0',
  detection_id: ulid('adsb-heli'),
  ts: isoAt(-2),
  sensor_id: 'sdr-0',
  sensor_kind: 'sdr',
  detection_class: 'D',
  rf: { freq_hz: 1_090_000_000, channel: null, rssi_dbm: -74, bandwidth_hz: 2_000_000 },
  position: {
    lat: helicopterPos.lat,
    lon: helicopterPos.lon,
    alt_geodetic_m: 640,
    alt_pressure_m: 632,
    height_agl_m: null,
    h_accuracy_m: 10,
    v_accuracy_m: 15,
  },
  kinematics: { speed_mps: 46.3, track_deg: 218, vertical_speed_mps: -1.2 },
  adsb: { icao: '4B1814', callsign: 'REGA10', alt_ft: 2100, ground_speed_kt: 90 },
}

export const adsbAirliner: Detection = {
  schema_version: '1.0',
  detection_id: ulid('adsb-airliner'),
  ts: isoAt(-5),
  sensor_id: 'sdr-0',
  sensor_kind: 'sdr',
  detection_class: 'D',
  rf: { freq_hz: 1_090_000_000, channel: null, rssi_dbm: -88, bandwidth_hz: 2_000_000 },
  position: {
    lat: airlinerPos.lat,
    lon: airlinerPos.lon,
    alt_geodetic_m: 3810,
    alt_pressure_m: 3795,
    height_agl_m: null,
    h_accuracy_m: 10,
    v_accuracy_m: 15,
  },
  kinematics: { speed_mps: 198.4, track_deg: 74, vertical_speed_mps: 7.6 },
  adsb: { icao: '4B0F21', callsign: 'SWR812', alt_ft: 12500, ground_speed_kt: 386 },
}

export const ADSB_DETECTIONS: Detection[] = [adsbHelicopter, adsbAirliner]

/** Class A detections behind the Mini 5 Pro track — used by the track detail view. */
export function mini5Detections(count = 60): Detection[] {
  return Array.from({ length: count }, (_, i) => {
    const offset = -1 - i * 2
    const pos = offsetLatLon(SITE.lat, SITE.lon, -40 + i * 8.6, 30 - i * 9.5)
    // RSSI walks from strong (close, -35 dBm at ~10 m per the calibration record)
    // to weaker as the aircraft moves away, with a little scatter.
    const rssi = -35 - i * 0.32 - (i % 5) * 1.4
    return {
      schema_version: '1.0',
      detection_id: ulid(`mini5-${i}`),
      ts: isoAt(offset),
      sensor_id: 'wifi-0',
      sensor_kind: 'wifi',
      detection_class: 'A',
      rf: {
        freq_hz: 2_437_000_000,
        channel: 6,
        rssi_dbm: Math.round(rssi * 10) / 10,
        bandwidth_hz: 20_000_000,
      },
      identity: {
        serial: '1581F5NCC2400A7YZ12K',
        mac: '8c:1e:d9:4a:22:07',
        id_type: 'serial_ansi_cta_2063',
        ua_type: 'multirotor',
        operator_id: null,
        self_id: null,
        vendor_hint: null,
      },
      position: {
        lat: pos.lat,
        lon: pos.lon,
        alt_geodetic_m: SITE.elevationM + 62 + i * 0.3,
        // The Mini 5 Pro does NOT report pressure altitude — invalid sentinel.
        alt_pressure_m: null,
        height_agl_m: 62 + i * 0.3,
        h_accuracy_m: 3,
        v_accuracy_m: 5,
      },
      kinematics: { speed_mps: 6.4, track_deg: 312, vertical_speed_mps: 0.15 },
      raw: { encoding: 'base64', bytes: 'ANEQAAAA', parser: 'odid/1.2' },
    } satisfies Detection
  }).reverse()
}

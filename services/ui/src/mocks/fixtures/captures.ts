/**
 * Capture fixtures.
 *
 * Milestone 0 is capture-driven, so the completed capture below is modelled on
 * exactly what `classg_wifi.cli analyze` is designed to answer:
 *
 *   - which channel the drone actually beacons on
 *   - the real beacon interval (the ~1 Hz assumption is UNTESTED)
 *   - whether operator location is being broadcast
 *   - the raw DJI field values
 *
 * Per docs/ops/04-calibration.md the DJI calibration table is expected to be
 * EMPTY for a Mini 5 Pro, because it broadcasts standard Remote ID over Wi-Fi
 * Beacon and carries DJI's proprietary DroneID on OcuSync, out of reach of both
 * radios. The report fixture reflects that rather than inventing numbers.
 */
import type { Capture, CaptureReport } from '@/lib/api/types'

import { isoAt } from './site'

export const captureFirstFlight: Capture = {
  capture_id: '01J8XP2K7R4TQ9MB3CVDEW6NAZ',
  filename: '2026-08-10-first-flight.pcap',
  state: 'completed',
  started_at: isoAt(-3720),
  ended_at: isoAt(-3600),
  iface: 'wlan1',
  channel: 6,
  duration_s: 120,
  size_bytes: 481_233,
  frame_count: 1841,
  analysis: { analyzed: true, drone_transmitters: 1, class_a: 118, class_b: 0 },
}

export const captureSweep: Capture = {
  capture_id: '01J8XPB4M2N8HKC5RTWY07VZQD',
  filename: '2026-08-10-sweep-ch1.pcap',
  state: 'completed',
  started_at: isoAt(-9200),
  ended_at: isoAt(-9080),
  iface: 'wlan1',
  channel: 1,
  duration_s: 120,
  size_bytes: 96_410,
  frame_count: 412,
  analysis: { analyzed: true, drone_transmitters: 0, class_a: 0, class_b: 0 },
}

export const captureFailed: Capture = {
  capture_id: '01J8XPCT9E6WJ2P0AQXZ84BKNR',
  filename: '2026-08-10-ch11.pcap',
  state: 'failed',
  started_at: isoAt(-11_400),
  ended_at: isoAt(-11_398),
  iface: 'wlan1',
  channel: 11,
  duration_s: 0,
  size_bytes: 0,
  frame_count: 0,
}

export const CAPTURES: Capture[] = [captureFirstFlight, captureSweep, captureFailed]

export const reportFirstFlight: CaptureReport = {
  capture_id: captureFirstFlight.capture_id,
  frames: 1841,
  beacons: 1602,
  parse_errors: 3,
  transmitters: 19,
  channel_usage: [{ channel: 6, beacons: 118 }],
  beacon_interval: {
    median_ms: 1012,
    min_ms: 934,
    max_ms: 1288,
    samples: 117,
    rate_hz: 0.99,
  },
  identities: [
    {
      mac: '8c:1e:d9:4a:22:07',
      ssid: null,
      serial: '1581F5NCC2400A7YZ12K',
      id_type: 'serial_ansi_cta_2063',
      ua_type: 'Helicopter_or_Multirotor',
      manufacturer_code: '1581',
      // The calibration record is explicit: this OUI is not in our fingerprint
      // list, so the vendor is unverified from the transmitter address alone.
      vendor: null,
      protocol_version: 2,
      odid_count: 118,
      dji_count: 0,
      channels: [6],
      rssi_min_dbm: -41,
      rssi_max_dbm: -35,
      rssi_median_dbm: -37,
      operator_location_broadcast: true,
    },
  ],
  // Empty: no DJI vendor IE was present. Expected for this aircraft.
  dji_calibration: [],
}

export const reportSweep: CaptureReport = {
  capture_id: captureSweep.capture_id,
  frames: 412,
  beacons: 380,
  parse_errors: 0,
  transmitters: 11,
  channel_usage: [],
  beacon_interval: null,
  identities: [],
  dji_calibration: [],
}

export const REPORTS: Record<string, CaptureReport> = {
  [captureFirstFlight.capture_id]: reportFirstFlight,
  [captureSweep.capture_id]: reportSweep,
}

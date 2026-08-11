/**
 * Health fixtures — one per scenario.
 *
 * These exist so the single most important thing the interface communicates can
 * be demonstrated and tested: an empty map with a broken sensor must not look
 * like an empty map with healthy sensors and a quiet sky.
 */
import type { Health, SensorHealth, SensorRuntimeConfig } from '@/lib/api/types'

import { isoAt } from './site'

/**
 * `config` is what `GET /sensors` adds on top of `/health`, and the capture and
 * restart controls read it directly. The fixtures had drifted to an older shape
 * (`iface`, `plan`, `device`) that the contract no longer has — which meant the
 * mock backend was exercising a UI path that could not occur against a real API.
 */
const wifiConfig: SensorRuntimeConfig = {
  unit: 'classg-sensor-wifi.service',
  stale_after_s: 120,
  expected: true,
  restart_command: 'systemctl restart classg-sensor-wifi.service',
  restart_available: true,
  capture: {
    supported: true,
    interface: 'wlan1',
    channel: 6,
    duration_s: 120,
    label: 'wifi-0',
  },
}

const sdrConfig: SensorRuntimeConfig = {
  unit: 'classg-sensor-sdr.service',
  stale_after_s: 120,
  expected: true,
  restart_command: 'systemctl restart classg-sensor-sdr.service',
  restart_available: true,
  // The SDR path has no packet capture: it is an IQ receiver, not a Wi-Fi NIC.
  capture: { supported: false },
}

const wifiHealthy: SensorHealth = {
  sensor_id: 'wifi-0',
  sensor_kind: 'wifi',
  healthy: true,
  last_heartbeat: isoAt(-3),
  seconds_since_heartbeat: 3,
  detections_5m: 402,
  detail: { channel: 6, listening_fraction: 0.71, hop_dwell_ms: 400 },
  config: wifiConfig,
}

const sdrHealthy: SensorHealth = {
  sensor_id: 'sdr-0',
  sensor_kind: 'sdr',
  healthy: true,
  last_heartbeat: isoAt(-2),
  seconds_since_heartbeat: 2,
  detections_5m: 37,
  detail: { band: 'adsb-1090', sample_rate_sps: 2_400_000, gain_db: 34.6 },
  config: sdrConfig,
}

const sdrDown: SensorHealth = {
  sensor_id: 'sdr-0',
  sensor_kind: 'sdr',
  healthy: false,
  last_heartbeat: isoAt(-1098),
  seconds_since_heartbeat: 1098,
  reason: 'device not found',
  config: sdrConfig,
}

const wifiDown: SensorHealth = {
  sensor_id: 'wifi-0',
  sensor_kind: 'wifi',
  healthy: false,
  last_heartbeat: isoAt(-412),
  seconds_since_heartbeat: 412,
  reason: 'mt7921u: no frames for 120 s while interface is up; interface reset failed',
  config: wifiConfig,
}

/** Everything working, drones in the air. */
export const healthOk: Health = {
  status: 'ok',
  uptime_s: 8412,
  version: '0.1.0-dev',
  sensors: [wifiHealthy, sdrHealthy],
}

/**
 * Everything working, nothing flying. `detections_5m: 0` with `healthy: true`.
 * The map is empty and that empty map is TRUSTWORTHY.
 */
export const healthQuietSky: Health = {
  status: 'ok',
  uptime_s: 8412,
  version: '0.1.0-dev',
  sensors: [
    { ...wifiHealthy, detections_5m: 0 },
    { ...sdrHealthy, detections_5m: 0 },
  ],
}

/**
 * The SDR is gone. The map may also be empty, but that empty map means nothing —
 * it must not be read as "no drones".
 */
export const healthDegraded: Health = {
  status: 'degraded',
  uptime_s: 8412,
  version: '0.1.0-dev',
  sensors: [{ ...wifiHealthy, detections_5m: 0 }, sdrDown],
}

/** Both radios gone — e.g. the USB power brownout in the failure-mode table. */
export const healthDown: Health = {
  status: 'down',
  uptime_s: 8412,
  version: '0.1.0-dev',
  sensors: [wifiDown, sdrDown],
}

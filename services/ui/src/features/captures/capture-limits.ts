/**
 * What this build cannot do, as a sentence a page can join with the others.
 *
 * Kept out of sensor-captures.tsx so that file exports only components (Fast
 * Refresh, same reason as button-variants.ts), and kept out of the control
 * itself because the point is that it is *not* rendered where it is
 * discovered: the sensor page had two permanent error-styled boxes describing
 * the build rather than a fault — systemctl unreachable from the API
 * container, capture unwritten for SDR sensors — and on a unit where both are
 * always true it opened on two red-edged alerts about nothing being wrong.
 */
import type { SensorHealth } from '@/lib/api/types'

/**
 * Why this sensor offers no capture control, or null if it does.
 *
 * Lower-case and unterminated, so the caller can join several into one line.
 */
export function captureLimitation(sensor: SensorHealth): string | null {
  if (sensor.config?.capture.supported) return null
  return `capture is not implemented for ${sensor.sensor_kind.toUpperCase()} sensors`
}

/**
 * Channel occupancy, read out of the Wi-Fi sensor's heartbeat detail.
 *
 * The SDR tunes 500 kHz – 1.766 GHz, so the sweep view is silent about 2.4 and
 * 5 GHz — which is where every DJI drone talks. The Wi-Fi adapter cannot
 * produce an FFT, but the driver keeps per-channel busy-time and noise counters
 * and the sensor publishes them. That is the honest second source for this
 * page: occupancy, not identification.
 *
 * `detail` is deliberately free-form on the wire — it is whatever a sensor chose
 * to publish — so this module is where the shape is asserted, once, and
 * anything malformed is dropped rather than rendered as a zero. A channel drawn
 * at 0% busy because a field was missing is worse than a channel not drawn.
 */
import type { SensorHealth } from '@/lib/api/types'

type BandKey = '2.4' | '5' | '6'

export interface ChannelOccupancy {
  freqMHz: number
  /** 802.11 channel, absent when the frequency is off-plan. */
  channel: number | null
  band: BandKey
  /** Time the radio spent on this channel during the window, ms. */
  activeMs: number
  /** How much of that time the medium was busy, 0–1. */
  busyFraction: number
  /** Driver's noise measurement in dBm, absent when it reported none. */
  noiseDbm: number | null
  /** Time spent receiving, ms. */
  rxMs: number
  /**
   * Time spent transmitting, ms. Must be zero: this is a receive-only system
   * on a monitor-mode interface, so a non-zero reading here is not a detail,
   * it is the one number on this page worth escalating.
   */
  txMs: number
  /** The channel the hopper was parked on when the sample was taken. */
  inUse: boolean
}

export type SurveyState =
  /** No Wi-Fi sensor is reporting at all. */
  | { kind: 'no-sensor' }
  /** The sensor is there but has not said whether it can survey. */
  | { kind: 'unknown'; sensorId: string }
  /** The adapter or its driver has no survey worth drawing, and why. */
  | { kind: 'unsupported'; sensorId: string; reason: string }
  /** Surveying, but the first window has not closed yet. */
  | { kind: 'warming'; sensorId: string }
  | { kind: 'ready'; sensorId: string; channels: ChannelOccupancy[] }

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readChannel(raw: unknown): ChannelOccupancy | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>

  const freqMHz = num(entry.freq_mhz)
  const activeMs = num(entry.active_ms)
  const busyFraction = num(entry.busy_fraction)
  // All three are what make a bar mean anything. Without them there is no
  // measurement to draw, whatever else the entry carries.
  if (freqMHz === null || activeMs === null || busyFraction === null) return null

  const band = entry.band
  return {
    freqMHz,
    channel: num(entry.channel),
    band: band === '2.4' || band === '5' || band === '6' ? band : bandFor(freqMHz),
    activeMs,
    busyFraction: Math.min(Math.max(busyFraction, 0), 1),
    noiseDbm: num(entry.noise_dbm),
    rxMs: num(entry.rx_ms) ?? 0,
    txMs: num(entry.tx_ms) ?? 0,
    inUse: entry.in_use === true,
  }
}

function bandFor(freqMHz: number): BandKey {
  if (freqMHz < 3000) return '2.4'
  if (freqMHz < 5925) return '5'
  return '6'
}

/**
 * One Wi-Fi sensor's occupancy reading, or why there isn't one.
 *
 * `sensorId` picks which. It used to take the first Wi-Fi sensor it found,
 * which was the same thing while there was only one; with two receivers that
 * meant selecting wifi-1 rendered an occupancy card describing wifi-0's radio.
 * Falling back to the first keeps the no-argument behaviour for callers that
 * have no particular sensor in mind.
 */
export function surveyState(sensors: SensorHealth[] | undefined, want?: string): SurveyState {
  const wifi = (sensors ?? []).filter((s) => s.sensor_kind === 'wifi')
  const sensor = want ? wifi.find((s) => s.sensor_id === want) : wifi[0]
  if (!sensor) return { kind: 'no-sensor' }

  const sensorId = sensor.sensor_id
  const detail = sensor.detail ?? {}
  const available = detail.survey_available
  const reason = typeof detail.survey_reason === 'string' ? detail.survey_reason : ''

  // Two different ways to have nothing, and only one of them is worth an
  // operator's time. `available: false` is "iw said nothing at all" -- a
  // missing package. A reason alongside `available: true` is "the driver
  // answered with counters that mean nothing", which needs different hardware
  // rather than different config. Measured on this unit's mt7921u; see
  // classg_wifi/survey.py.
  if (available === false || reason !== '') {
    return {
      kind: 'unsupported',
      sensorId,
      reason: reason !== '' ? reason : 'the driver reported no survey for this interface',
    }
  }

  const raw = detail.survey
  if (!Array.isArray(raw)) {
    // The sensor has said it can survey but has published no window yet, which
    // is every first heartbeat after a restart: the counters are cumulative, so
    // the first reading has nothing to difference against.
    return available === true ? { kind: 'warming', sensorId } : { kind: 'unknown', sensorId }
  }

  const channels = raw
    .map(readChannel)
    .filter((c): c is ChannelOccupancy => c !== null)
    .sort((a, b) => a.freqMHz - b.freqMHz)

  if (channels.length === 0) return { kind: 'warming', sensorId }
  return { kind: 'ready', sensorId, channels }
}

export interface OccupancyBand {
  band: BandKey
  label: string
  channels: ChannelOccupancy[]
}

const BAND_LABELS: Record<BandKey, string> = {
  '2.4': '2.4 GHz',
  '5': '5 GHz',
  '6': '6 GHz',
}

/** Group for display, skipping bands with nothing measured in this window. */
export function groupByBand(channels: ChannelOccupancy[]): OccupancyBand[] {
  const order: BandKey[] = ['2.4', '5', '6']
  return order
    .map((band) => ({
      band,
      label: BAND_LABELS[band],
      channels: channels.filter((c) => c.band === band),
    }))
    .filter((group) => group.channels.length > 0)
}

/**
 * The busiest channel in the window, or null.
 *
 * Weighted by nothing: the loudest channel is the loudest channel. It is worth
 * showing because a channel that is busy while the map is empty is the shape of
 * a transmitter this system cannot identify — which is a thing to go and look
 * at, not a detection.
 */
export function busiest(channels: ChannelOccupancy[]): ChannelOccupancy | null {
  let best: ChannelOccupancy | null = null
  for (const channel of channels) {
    if (best === null || channel.busyFraction > best.busyFraction) best = channel
  }
  return best
}

/** Any channel reporting transmit time. Should always be empty. */
export function transmitting(channels: ChannelOccupancy[]): ChannelOccupancy[] {
  return channels.filter((c) => c.txMs > 0)
}

export function formatChannel(channel: ChannelOccupancy): string {
  return channel.channel === null ? `${channel.freqMHz} MHz` : `ch ${channel.channel}`
}

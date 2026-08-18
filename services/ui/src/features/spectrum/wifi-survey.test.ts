import { describe, expect, it } from 'vitest'

import type { SensorHealth } from '@/lib/api/types'

import { busiest, groupByBand, surveyState, transmitting } from './wifi-survey'

function wifi(detail: Record<string, unknown>): SensorHealth {
  return {
    sensor_id: 'wifi-0',
    sensor_kind: 'wifi',
    healthy: true,
    last_heartbeat: '2026-08-18T00:00:00Z',
    seconds_since_heartbeat: 1,
    detail,
  }
}

const CHANNEL_6 = {
  freq_mhz: 2437,
  channel: 6,
  band: '2.4',
  active_ms: 1000,
  busy_ms: 400,
  busy_fraction: 0.4,
  rx_ms: 250,
  tx_ms: 0,
  in_use: true,
  noise_dbm: -92,
}

describe('surveyState', () => {
  it('reports no sensor rather than an empty chart', () => {
    expect(surveyState([]).kind).toBe('no-sensor')
    expect(surveyState(undefined).kind).toBe('no-sensor')
  })

  it('distinguishes an adapter that cannot survey from one that has not yet', () => {
    // These look identical on screen if collapsed into "no data", and they are
    // completely different facts: one needs a different adapter, the other
    // needs ten more seconds.
    expect(surveyState([wifi({ survey_available: false })]).kind).toBe('unsupported')
    expect(surveyState([wifi({ survey_available: true })]).kind).toBe('warming')
    expect(surveyState([wifi({})]).kind).toBe('unknown')
  })

  it('reads a published window', () => {
    const state = surveyState([wifi({ survey_available: true, survey: [CHANNEL_6] })])

    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.sensorId).toBe('wifi-0')
    expect(state.channels).toEqual([
      {
        freqMHz: 2437,
        channel: 6,
        band: '2.4',
        activeMs: 1000,
        busyFraction: 0.4,
        noiseDbm: -92,
        rxMs: 250,
        txMs: 0,
        inUse: true,
      },
    ])
  })

  it('drops an entry missing the numbers a bar is made of', () => {
    // Rendering a malformed entry as 0% busy would claim a quiet channel on the
    // strength of a missing field.
    const state = surveyState([
      wifi({
        survey_available: true,
        survey: [CHANNEL_6, { freq_mhz: 2412 }, { channel: 11 }, 'nonsense', null],
      }),
    ])

    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.channels.map((c) => c.freqMHz)).toEqual([2437])
  })

  it('sorts by frequency and derives a missing band label', () => {
    const state = surveyState([
      wifi({
        survey_available: true,
        survey: [
          { freq_mhz: 5180, active_ms: 500, busy_fraction: 0.1 },
          { ...CHANNEL_6, band: undefined },
        ],
      }),
    ])

    if (state.kind !== 'ready') throw new Error('expected a reading')
    expect(state.channels.map((c) => c.freqMHz)).toEqual([2437, 5180])
    expect(state.channels[0]?.band).toBe('2.4')
    expect(state.channels[1]?.band).toBe('5')
  })

  it('clamps a busy fraction the driver overshot', () => {
    const state = surveyState([
      wifi({ survey_available: true, survey: [{ ...CHANNEL_6, busy_fraction: 1.4 }] }),
    ])
    if (state.kind !== 'ready') throw new Error('expected a reading')
    expect(state.channels[0]?.busyFraction).toBe(1)
  })

  it('treats a published but empty survey as warming, not as a quiet band', () => {
    expect(surveyState([wifi({ survey_available: true, survey: [] })]).kind).toBe('warming')
  })
})

describe('grouping and summaries', () => {
  const channels = [
    { ...CHANNEL_6, busy_fraction: 0.4 },
    { freq_mhz: 5180, channel: 36, band: '5', active_ms: 400, busy_fraction: 0.8, tx_ms: 0 },
  ]

  it('omits a band with nothing measured in this window', () => {
    const state = surveyState([wifi({ survey_available: true, survey: channels })])
    if (state.kind !== 'ready') throw new Error('expected a reading')

    expect(groupByBand(state.channels).map((g) => g.label)).toEqual(['2.4 GHz', '5 GHz'])
  })

  it('names the busiest channel', () => {
    const state = surveyState([wifi({ survey_available: true, survey: channels })])
    if (state.kind !== 'ready') throw new Error('expected a reading')

    expect(busiest(state.channels)?.freqMHz).toBe(5180)
    expect(busiest([])).toBeNull()
  })

  it('finds transmit time, which must never exist on this system', () => {
    const state = surveyState([
      wifi({ survey_available: true, survey: [{ ...CHANNEL_6, tx_ms: 12 }] }),
    ])
    if (state.kind !== 'ready') throw new Error('expected a reading')

    expect(transmitting(state.channels)).toHaveLength(1)
  })
})

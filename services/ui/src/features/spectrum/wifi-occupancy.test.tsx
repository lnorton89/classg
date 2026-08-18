import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { WifiOccupancyPanel } from './wifi-occupancy'

const API = '*/api/v1'

let sensors: unknown[] = []

const server = setupServer(http.get(`${API}/sensors`, () => HttpResponse.json({ sensors })))

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  sensors = []
})
afterAll(() => server.close())

function wifi(detail: Record<string, unknown>) {
  return {
    sensor_id: 'wifi-0',
    sensor_kind: 'wifi',
    healthy: true,
    last_heartbeat: '2026-08-18T00:00:00Z',
    seconds_since_heartbeat: 2,
    detail,
  }
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <WifiOccupancyPanel />
    </QueryClientProvider>,
  )
}

const CHANNELS = [
  {
    freq_mhz: 2437,
    channel: 6,
    band: '2.4',
    active_ms: 4000,
    busy_fraction: 0.66,
    rx_ms: 1900,
    tx_ms: 0,
    noise_dbm: -92,
    in_use: true,
  },
  {
    freq_mhz: 5180,
    channel: 36,
    band: '5',
    active_ms: 400,
    busy_fraction: 0.08,
    rx_ms: 22,
    tx_ms: 0,
    noise_dbm: -101,
    in_use: false,
  },
]

describe('WifiOccupancyPanel', () => {
  it('draws a bar per measured channel, grouped by band', async () => {
    sensors = [wifi({ survey_available: true, survey: CHANNELS })]
    renderPanel()

    expect(await screen.findByText('2.4 GHz')).toBeVisible()
    expect(screen.getByText('5 GHz')).toBeVisible()
    expect(screen.getByLabelText('ch 6: 66 percent busy')).toBeVisible()
    expect(screen.getByLabelText('ch 36: 8 percent busy')).toBeVisible()
  })

  it('says which adapter cannot survey rather than drawing an empty band', async () => {
    // The failure this guards: an adapter with no counters rendering as a wall
    // of 0% bars, which reads as a silent spectrum rather than as no data.
    sensors = [wifi({ survey_available: false })]
    renderPanel()

    expect(await screen.findByText('This adapter reports no channel occupancy')).toBeVisible()
    expect(screen.queryByText('2.4 GHz')).not.toBeInTheDocument()
  })

  // What the unit's own mt7921u does: iw answers, with one 6 GHz entry whose
  // active time advances and whose busy time and noise are absent. The sensor
  // says so in words, and those words are what belongs on screen -- not a bar
  // at 0%, which is what shipped before the hardware was asked.
  it('repeats the sensor reason when the driver answers with nothing usable', async () => {
    sensors = [
      wifi({
        survey_available: true,
        survey_reason:
          'the driver returned 1 survey entry carrying no busy time and no noise floor, ' +
          'so there is no occupancy to report',
        survey_seen: 1,
      }),
    ]
    renderPanel()

    expect(await screen.findByText(/carrying no busy time and no noise floor/)).toBeVisible()
    expect(screen.queryByText('Measuring the first window')).not.toBeInTheDocument()
  })

  it('explains the first window instead of showing nothing', async () => {
    sensors = [wifi({ survey_available: true })]
    renderPanel()

    expect(await screen.findByText('Measuring the first window')).toBeVisible()
  })

  // A sensor build older than the feature says nothing about surveys at all.
  // Calling that "measuring the first window" promises a reading that will
  // never arrive -- and during a rollout it is the state the unit is actually
  // in, so it is the one most likely to be seen.
  it('does not claim to be measuring when the sensor never mentioned a survey', async () => {
    sensors = [wifi({ channel: 6 })]
    renderPanel()

    expect(await screen.findByText('This sensor reports no occupancy')).toBeVisible()
    expect(screen.queryByText('Measuring the first window')).not.toBeInTheDocument()
  })

  it('escalates transmit time, which a receive-only system must never report', async () => {
    sensors = [wifi({ survey_available: true, survey: [{ ...CHANNELS[0], tx_ms: 14 }] })]
    renderPanel()

    expect(await screen.findByText('This interface reports transmit time')).toBeVisible()
  })

  it('reports a missing sensor as a missing sensor', async () => {
    sensors = []
    renderPanel()

    expect(await screen.findByText('No Wi-Fi sensor is reporting')).toBeVisible()
  })
})

/**
 * The browser preview in this environment cannot register the MSW service
 * worker the live app needs to mount, so the list-detail redesign here was
 * checked with a component-level render against the MSW node server instead
 * of eyeballing it. This pins the part that matters most: picking a sensor
 * or "Captures" from the list swaps the detail pane to the right content, and
 * a sensor's own spectrum measurement (Wi-Fi occupancy vs. the SDR sweep)
 * follows its kind rather than being a page of its own.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { ToastProvider } from '@/components/ui/toast-primitives'
import type * as ReactRouter from '@tanstack/react-router'
import type {
  Capture,
  CapturesResponse,
  Health,
  SensorHealth,
  TracksResponse,
} from '@/lib/api/types'

import { SensorsView } from './sensors'

// Only the capture history's "Report" link needs a router, and this suite is
// about the list-detail navigation, not routing -- a real RouterProvider
// would need every other route mocked along with it. Everything else
// (createFileRoute at module scope, notably) comes from the real package.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  }
})

const API = '*/api/v1'

let sensors: SensorHealth[] = []
let captures: Capture[] = []

const server = setupServer(
  http.get(`${API}/health`, () => {
    const health: Health = { status: 'ok', uptime_s: 3600, version: 'test', sensors }
    return HttpResponse.json(health)
  }),
  http.get(`${API}/sensors`, () => HttpResponse.json(sensors)),
  http.get(`${API}/tracks`, () => {
    const body: TracksResponse = { tracks: [], next_cursor: null, total: 0 }
    return HttpResponse.json(body)
  }),
  http.get(`${API}/captures`, () => {
    const body: CapturesResponse = { captures }
    return HttpResponse.json(body)
  }),
  http.get(`${API}/spectrum/bands`, () => HttpResponse.json({ bands: [], available: false })),
  http.get(`${API}/spectrum/sweeps`, () => HttpResponse.json({ sweeps: [] })),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  sensors = []
  captures = []
})
afterAll(() => server.close())

function sensor(id: string, kind: SensorHealth['sensor_kind']): SensorHealth {
  return {
    sensor_id: id,
    sensor_kind: kind,
    healthy: true,
    last_heartbeat: '2026-08-18T00:00:00Z',
    seconds_since_heartbeat: 2,
    detections_5m: 0,
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SensorsView />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('SensorsView', () => {
  it('defaults to the first sensor, with its own spectrum measurement folded into its detail', async () => {
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage()

    const nav = await screen.findByRole('navigation', { name: 'Sensors and captures' })
    expect(await within(nav).findByText('wifi-0')).toBeVisible()
    expect(within(nav).getByText('sdr-0')).toBeVisible()
    expect(within(nav).getByText('Captures')).toBeVisible()

    // wifi-0 is first, so it is the default detail -- its own occupancy view
    // comes with it, not the SDR's sweep.
    expect(await screen.findByText('Channel occupancy')).toBeVisible()
    expect(screen.queryByText('Band sweep')).not.toBeInTheDocument()
  })

  it("switches the spectrum view to the SDR's own sweep when the SDR sensor is selected", async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage()

    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: /sdr-0/ }))

    expect(await screen.findByText('Band sweep')).toBeVisible()
    expect(screen.queryByText('Channel occupancy')).not.toBeInTheDocument()
  })

  it('shows capture history instead of a sensor when Captures is selected', async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi')]
    captures = [
      {
        capture_id: 'cap-1',
        iface: 'wlan0',
        channel: 6,
        duration_s: 120,
        state: 'completed',
        filename: 'wifi-0-capture.pcap',
        size_bytes: 1024,
        frame_count: 40,
        started_at: '2026-08-18T00:00:00Z',
      },
    ]

    renderPage()

    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: /Captures/ }))

    expect(await screen.findByText('wifi-0-capture.pcap')).toBeVisible()
    expect(screen.queryByText('Channel occupancy')).not.toBeInTheDocument()
  })

  it('can return to the list and select a different sensor', async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage()

    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: 'All sensors' }))
    await user.click(screen.getByRole('button', { name: /sdr-0/ }))

    expect(await screen.findByText('Band sweep')).toBeVisible()
  })

  it('says so when nothing is reporting, instead of an empty pane', async () => {
    sensors = []
    captures = []
    renderPage()

    expect(await screen.findByText('No sensors are reporting')).toBeVisible()
  })
})

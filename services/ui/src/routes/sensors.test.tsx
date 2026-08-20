/**
 * The browser preview in this environment cannot register the MSW service
 * worker the live app needs to mount, so the list-detail redesign here was
 * checked with a component-level render against the MSW node server instead
 * of eyeballing it. This pins the part that matters most: picking a sensor
 * or "Captures" from the list swaps the detail pane to the right content, a
 * sensor's own spectrum measurement (Wi-Fi occupancy vs. the SDR sweep)
 * follows its kind rather than being a page of its own, and the selection
 * lives in the URL rather than resetting on every render.
 *
 * A real router, not a mocked one: the selection is now `Route.useSearch()`
 * state, which only exists inside an actual route match. A minimal root
 * carries just the `{ queryClient }` context the loader needs, not the real
 * app shell (auth gate, header chrome) `routes/__root.tsx` renders.
 *
 * The route tree here is built with `createRoute`, not the `SensorsView`
 * module's own file-based `Route` export directly: `createFileRoute` leaves
 * `getParentRoute` unset at runtime -- the vite plugin injects it during the
 * real build, and vitest.config.ts deliberately skips that plugin (see its
 * own comment) -- so attaching the file route as-is under a fresh root
 * collides on the root id. `Route.useSearch()` inside `SensorsView` resolves
 * by matching route id against the router's current state, not by object
 * identity, so a `createRoute` standing in with the same path and search
 * schema (exported from sensors.tsx to avoid a second copy of it) works.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRoute,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { ToastProvider } from '@/components/ui/toast-primitives'
import type {
  Capture,
  CapturesResponse,
  Health,
  SensorHealth,
  TracksResponse,
} from '@/lib/api/types'

import { sensorsSearchSchema, SensorsView } from './sensors'

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

function renderPage(initialPath = '/sensors') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => <Outlet />,
  })
  const sensorsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sensors',
    validateSearch: sensorsSearchSchema,
    component: SensorsView,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([sensorsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: { queryClient: client },
  })
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- the router built here is a test-only subset of the real route tree, not the app's registered one. */}
        <RouterProvider router={router as any} />
      </ToastProvider>
    </QueryClientProvider>,
  )
  // Memory history never touches window.location -- the URL a test can
  // actually observe is the router's own, which is the whole point of
  // asserting it reflects the selection.
  return { ...result, router }
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

  it('reflects the selected sensor in the URL', async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    const { router } = renderPage()

    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: /sdr-0/ }))
    await screen.findByText('Band sweep')

    expect(router.state.location.search).toEqual({ sensor: 'sdr-0' })
  })

  it('opening a URL with a sensor already selected shows that sensor, not the default', async () => {
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage('/sensors?sensor=sdr-0')

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

    const { router } = renderPage()

    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: /Captures/ }))

    expect(await screen.findByText('wifi-0-capture.pcap')).toBeVisible()
    expect(screen.queryByText('Channel occupancy')).not.toBeInTheDocument()
    expect(router.state.location.search).toEqual({ view: 'captures' })
  })

  // A failed capture used to render a red badge and nothing else, because the
  // UI's Capture type never declared `error` -- so the API's reason for the
  // failure arrived on every response and was thrown away. scripts/check-mirrors.py
  // now compares the two field lists so the type cannot silently fall behind again.
  it('shows why a capture failed, not just that it did', async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi')]
    captures = [
      {
        capture_id: 'cap-2',
        iface: 'wlan1',
        channel: 6,
        duration_s: 120,
        state: 'failed',
        filename: 'wifi-0-doomed.pcap',
        size_bytes: 0,
        frame_count: 0,
        started_at: '2026-08-18T00:00:00Z',
        error: 'wlan1 is not in monitor mode',
      },
    ]

    renderPage()
    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: /Captures/ }))

    expect(await screen.findByText('wifi-0-doomed.pcap')).toBeVisible()
    expect(screen.getByText('failed')).toBeVisible()
    expect(screen.getByText('wlan1 is not in monitor mode')).toBeVisible()
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

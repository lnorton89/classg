/**
 * The browser preview in this environment cannot register the MSW service
 * worker the live app needs to mount, so the list-detail redesign here was
 * checked with a component-level render against the MSW node server instead
 * of eyeballing it. This pins the part that matters most: picking a sensor
 * from the list swaps the detail pane to it, a sensor's own spectrum
 * measurement (Wi-Fi occupancy vs. the SDR sweep) follows its kind rather than
 * being a page of its own, and the selection lives in the URL rather than
 * resetting on every render.
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

function sensorConfig(
  overrides: Partial<NonNullable<SensorHealth['config']>> = {},
): NonNullable<SensorHealth['config']> {
  return {
    unit: 'classg-sensor-wifi.service',
    stale_after_s: 30,
    expected: true,
    restart_command: 'systemctl restart classg-sensor-wifi.service',
    restart_available: true,
    capture: { supported: false },
    ...overrides,
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

    const nav = await screen.findByRole('navigation', { name: 'Sensors' })
    expect(await within(nav).findByText('wifi-0')).toBeVisible()
    expect(within(nav).getByText('sdr-0')).toBeVisible()

    // wifi-0 is first, so it is the default detail -- its own occupancy view
    // comes with it, not the SDR's sweep.
    expect(await screen.findByText('Channel occupancy')).toBeVisible()
    expect(screen.queryByText('Band sweep')).not.toBeInTheDocument()
  })

  /**
   * The sweep tool itself is a page now (`/spectrum`), not a panel folded into
   * this card: comparing a band against itself over weeks is a task somebody
   * comes to the console to do, and it was reachable only by knowing to select
   * sdr-0 and scroll. What stays here is the trail between the measurement and
   * the radio that takes it.
   */
  it('links the SDR to the sweep page rather than embedding the sweep tool', async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage()

    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: /sdr-0/ }))

    expect(await screen.findByRole('link', { name: /Band sweeps/ })).toHaveAttribute(
      'href',
      '/spectrum',
    )
    // Neither the other sensor's measurement nor the sweep tool itself.
    expect(screen.queryByText('Channel occupancy')).not.toBeInTheDocument()
    expect(screen.queryByText('Band sweep')).not.toBeInTheDocument()
  })

  it('reflects the selected sensor in the URL', async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    const { router } = renderPage()

    await screen.findByText('Channel occupancy')
    await user.click(screen.getByRole('button', { name: /sdr-0/ }))
    await screen.findByRole('link', { name: /Band sweeps/ })

    expect(router.state.location.search).toEqual({ sensor: 'sdr-0' })
  })

  it('opening a URL with a sensor already selected shows that sensor, not the default', async () => {
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage('/sensors?sensor=sdr-0')

    expect(await screen.findByRole('link', { name: /Band sweeps/ })).toBeVisible()
    expect(screen.queryByText('Channel occupancy')).not.toBeInTheDocument()
  })

  /**
   * The captures pane is gone from this page: `/captures` is a real route, and
   * a second copy of that list here meant two URLs for one list. What is left
   * is the count and the way there — the count because "has this unit recorded
   * anything" is a fair question to answer beside the radios that record, and
   * the link because the list itself belongs to one page.
   *
   * `view=captures` is out of the search schema with it. TanStack strips an
   * unknown key rather than failing on it, so a stale bookmark lands on the
   * first sensor instead of an error.
   */
  it('links to the captures route with a count instead of listing them here', async () => {
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
    const nav = screen.getByRole('navigation', { name: 'Sensors' })
    const link = await within(nav).findByRole('link', { name: /1 recording/ })
    expect(link).toHaveAttribute('href', '/captures')
    // The list itself is not duplicated here.
    expect(screen.queryByText('wifi-0-capture.pcap')).not.toBeInTheDocument()
    expect(screen.queryByText('Capture history')).not.toBeInTheDocument()
  })

  it('drops the retired view=captures parameter instead of rendering a pane', async () => {
    // The schema no longer knows the key, so it never reaches the component.
    expect(sensorsSearchSchema.parse({ view: 'captures', sensor: 'sdr-0' })).toEqual({
      sensor: 'sdr-0',
    })

    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage('/sensors?view=captures')

    // A stale bookmark lands on the first sensor rather than an error or an
    // empty pane. TanStack leaves the unrecognised key in the raw URL; what
    // matters is that nothing reads it.
    expect(await screen.findByText('Channel occupancy')).toBeVisible()
    expect(screen.queryByText('Capture history')).not.toBeInTheDocument()
  })

  // `expected` has always been on the wire and nothing rendered it, which is
  // the worst pairing for this flag in particular: an undeclared sensor looks
  // completely normal until it dies, and then it does not go unhealthy -- it
  // disappears, and overall health stays "ok" with one fewer receiver. There
  // is no later moment at which to notice.
  it('warns that an undeclared sensor would vanish rather than fail', async () => {
    sensors = [{ ...sensor('wifi-1', 'wifi'), config: sensorConfig({ expected: false }) }]
    renderPage()

    expect(
      await screen.findByText(/Not declared, so its failure would be silent/),
    ).toBeVisible()
    expect(screen.getByText('wifi-1:wifi')).toBeVisible()
  })

  it('says nothing about a sensor that is declared', async () => {
    sensors = [{ ...sensor('wifi-0', 'wifi'), config: sensorConfig({ expected: true }) }]
    renderPage()

    await screen.findByText('Channel occupancy')
    expect(screen.queryByText(/Not declared/)).not.toBeInTheDocument()
  })

  /**
   * The way back moved into the page header's eyebrow, with every other detail
   * view's — and it appears only once something has actually been selected.
   * Before that the list is what a phone is showing, so there is nothing to go
   * back to.
   */
  it('can return to the list and select a different sensor', async () => {
    const user = userEvent.setup()
    sensors = [sensor('wifi-0', 'wifi'), sensor('sdr-0', 'sdr')]
    renderPage()

    await screen.findByText('Channel occupancy')
    expect(screen.queryByRole('button', { name: 'All sensors' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /sdr-0/ }))
    await screen.findByRole('link', { name: /Band sweeps/ })

    await user.click(screen.getByRole('button', { name: 'All sensors' }))
    await user.click(screen.getByRole('button', { name: /wifi-0/ }))

    expect(await screen.findByText('Channel occupancy')).toBeVisible()
  })

  it('says so when nothing is reporting, instead of an empty pane', async () => {
    sensors = []
    captures = []
    renderPage()

    expect(await screen.findByText('No sensors are reporting')).toBeVisible()
  })
})

/**
 * The hierarchy pass, pinned.
 *
 * This page was the worst offender in the console: the richest data in the app
 * rendered as a forty-row key-value dump with no grouping by importance, two
 * permanent error-styled boxes describing the build rather than a fault, and
 * the driver's survey note printed twice. Each of those is a separate
 * regression a future edit could reintroduce without breaking anything else,
 * so each gets its own case.
 */
describe('the sensor detail leads with the story, not the dump', () => {
  const busyWifi: Record<string, unknown> = {
    beacons: 8_100_000,
    detections: 13_708,
    listening_fraction: 0.8618,
    hop_overhead_ms: 3_000_000,
    hops: 41_000,
    dwell_share: { '1': 0.281, '6': 0.576, '11': 0.143 },
    subscribers: 1,
    plan_swaps: 3,
    reconnects: 0,
  }

  it('puts the summary on screen and the rest behind a disclosure', async () => {
    sensors = [{ ...sensor('wifi-0', 'wifi'), detail: busyWifi }]
    renderPage()

    // The strip: heard, detected, what the hopping cost.
    expect(await screen.findByText('Heard')).toBeVisible()
    expect(screen.getByText('Drone detections')).toBeVisible()
    expect(screen.getByText('Listening share')).toBeVisible()
    expect(screen.getByText('Lost to hopping')).toBeVisible()

    // `plan_swaps` is real and still reachable, but it is not the story, so
    // it is inside a closed <details> rather than beside the headline figures.
    const counters = screen.getByText(/All counters/)
    expect(counters).toBeVisible()
    expect(counters.closest('details')?.open).toBe(false)
    expect(screen.getByText('Plan swaps').closest('details')).toBe(counters.closest('details'))
  })

  it('draws the per-channel dwell share as bars rather than as a comma list', async () => {
    sensors = [{ ...sensor('wifi-0', 'wifi'), detail: busyWifi }]
    const { container } = renderPage()

    expect(await screen.findByText('Dwell share by channel')).toBeVisible()
    expect(screen.getByText('ch 6')).toBeVisible()
    expect(screen.getByText('57.6%')).toBeVisible()
    expect(container.querySelectorAll('[role="img"]').length).toBeGreaterThanOrEqual(3)
  })

  it('does not print a promoted reading twice', async () => {
    sensors = [{ ...sensor('wifi-0', 'wifi'), detail: busyWifi }]
    renderPage()

    await screen.findByText('Heard')
    // "Beacons heard" is the full list's label for `beacons`; the strip has
    // taken it, so the row must be gone rather than restating it.
    expect(screen.queryByText('Beacons heard')).not.toBeInTheDocument()
    expect(screen.queryByText('Dwell share by channel')).toBeVisible()
    expect(screen.queryByText('Time lost to hopping')).not.toBeInTheDocument()
  })

  it('reduces the two build-limitation boxes to one muted line', async () => {
    sensors = [
      {
        ...sensor('sdr-0', 'sdr'),
        config: sensorConfig({
          restart_available: false,
          restart_unavailable_reason: 'systemctl is not available in the API runtime',
          capture: { supported: false },
        }),
      },
    ]
    renderPage()

    const line = await screen.findByText(/Not available in this build/)
    expect(line).toBeVisible()
    expect(line.textContent).toContain('systemctl is not available in the API runtime')
    expect(line.textContent).toContain('capture is not implemented for SDR sensors')
    // One line, not two alerts. An alert is for a fault; this is a build.
    expect(screen.queryByText('Restart unavailable')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says nothing about the build when the build can do everything', async () => {
    sensors = [
      {
        ...sensor('wifi-0', 'wifi'),
        config: sensorConfig({
          restart_available: true,
          capture: { supported: true, interface: 'wlan1' },
        }),
      },
    ]
    renderPage()

    await screen.findByText('Channel occupancy')
    expect(screen.queryByText(/Not available in this build/)).not.toBeInTheDocument()
  })

  it('prints the survey note once, in the panel that owns it', async () => {
    sensors = [
      {
        ...sensor('wifi-0', 'wifi'),
        detail: {
          ...busyWifi,
          survey_available: false,
          survey_reason: 'this adapter exposes no survey counters',
        },
      },
    ]
    renderPage()

    await screen.findByText('Heard')
    expect(screen.getAllByText(/this adapter exposes no survey counters/)).toHaveLength(1)
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SensorHealth, SettingsResponse } from '@/lib/api/types'

import { ChannelPlanView, ExpectedSensorsCard, ReceiverPositionEditor } from './calibration'

const API = '*/api/v1'

/** What the Wi-Fi receivers report having loaded, per test. */
let sensors: SensorHealth[] = []

const settings: SettingsResponse = {
  settings: {
    'map.receiver_position': {
      value: { lat: 51.4775, lon: -0.0014 },
      source: 'db',
      mutable: true,
    },
    // The ARRAY the API actually sends, not the string a client PUTs. The
    // first version of this mock used the string, which is why a field that
    // renders empty on the real unit passed its test.
    'sensors.expected': {
      value: [
        { sensor_id: 'wifi-0', sensor_kind: 'wifi' },
        { sensor_id: 'wifi-1', sensor_kind: 'wifi', optional: true },
        { sensor_id: 'sdr-0', sensor_kind: 'sdr', optional: true },
      ],
      source: 'db',
      mutable: true,
    },
  },
  env_overridden: [],
}

/** Every body PUT to /config/settings, so a test can assert nothing was sent. */
let puts: Record<string, string>[] = []

const server = setupServer(
  http.get(`${API}/config/settings`, () => HttpResponse.json(settings)),
  http.get(`${API}/config/channels`, () =>
    HttpResponse.json({
      value: {
        channels: [
          { channel: 6, freq_mhz: 2437, weight: 40 },
          { channel: 1, freq_mhz: 2412, weight: 10 },
        ],
      },
      restart_required: false,
    }),
  ),
  http.get(`${API}/sensors`, () => HttpResponse.json(sensors)),
  http.put(`${API}/config/settings`, async ({ request }) => {
    puts.push((await request.json()) as Record<string, string>)
    return HttpResponse.json({ restart_required: false })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  puts = []
  sensors = []
})
afterAll(() => server.close())

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReceiverPositionEditor />
    </QueryClientProvider>,
  )
}

// userEvent.clear() cannot empty a type="number" input under happy-dom (the
// selection APIs it relies on are unsupported there), so drive the controlled
// inputs through change events instead.
function setValue(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
}

describe('ReceiverPositionEditor', () => {
  it('refuses to save with one field blank, and says so', async () => {
    // The regression this pins down: Number('') is 0, so clearing only the
    // latitude and saving stored "0,<lon>" on the Pi — a receiver position on
    // the equator — instead of an error. 0 must never stand in for "unset".
    const user = userEvent.setup()
    renderEditor()

    // Wait for the fetched position to land in the fields first: firing a
    // change on a still-empty input is a no-op to React, and the Save button
    // stays disabled until something actually changes.
    await screen.findByDisplayValue('51.4775')
    setValue(screen.getByLabelText('Latitude'), '')
    await user.click(screen.getByRole('button', { name: /^Save/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Latitude is blank\. Fill in both fields, or clear both/,
    )
    expect(puts).toHaveLength(0)
  })

  it('still treats both fields blank as an explicit unset', async () => {
    const user = userEvent.setup()
    renderEditor()

    await screen.findByDisplayValue('51.4775')
    setValue(screen.getByLabelText('Latitude'), '')
    setValue(screen.getByLabelText('Longitude'), '')
    await user.click(screen.getByRole('button', { name: /^Save/ }))

    await waitFor(() => expect(puts).toEqual([{ 'map.receiver_position': '' }]))
  })

  it('saves both coordinates when both are present', async () => {
    const user = userEvent.setup()
    renderEditor()

    await screen.findByDisplayValue('51.4775')
    setValue(screen.getByLabelText('Latitude'), '48.85')
    await user.click(screen.getByRole('button', { name: /^Save/ }))

    await waitFor(() => expect(puts).toEqual([{ 'map.receiver_position': '48.85,-0.0014' }]))
  })
})

// The channel plan card used to answer a save with "Saved -- restart required:
// the sensor must be restarted for this to take effect." That is not true and
// never was. Sensors publish and subscribe to nothing (ADR-0002); each
// receiver reads its own channel file from disk at startup, and nothing writes
// this plan to any of those files -- so a restart re-reads the file, not this.
// The fusion weights card next to it had already been made honest about the
// identical situation; this one still promised an operator that restarting
// would apply an edit that it would silently discard.
// sensors.expected had no control anywhere, and CLASSG_EXPECTED_SENSORS does
// not reach the API container on the Compose deployment -- docker-compose.yml
// passes Tier 1 only, by design. So the production checklist's "declare every
// expected sensor" could not be followed as written on the deployment this
// project ships, and the live unit had two sensors undeclared: either could
// stop and simply vanish from /health while overall status stayed ok.
describe('ExpectedSensorsCard', () => {
  it('offers the setting, seeded from what the unit has stored', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ExpectedSensorsCard />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Expected sensors')).toBeVisible()
    // Round-tripped back into the form a PUT accepts, including :optional --
    // whatever this shows is what the operator edits and sends back.
    expect(
      await screen.findByDisplayValue('wifi-0:wifi,wifi-1:wifi:optional,sdr-0:sdr:optional'),
    ).toBeVisible()
  })
})

/**
 * The editor here was the clearest case of the console promising something it
 * could not do: a weight-per-channel table with a Save, under a banner saying
 * the Save reached no running receiver. It did not, and could not — the hopper
 * reads its channel file from disk at startup and sensors subscribe to nothing
 * (ADR-0002). What replaced it is a read-only comparison: the plan each radio
 * says it loaded, the plan recorded here, and a copy button for the file that
 * actually decides.
 */
describe('ChannelPlanView', () => {
  function wifi(id: string, detail: Record<string, unknown>): SensorHealth {
    return {
      sensor_id: id,
      sensor_kind: 'wifi',
      healthy: true,
      last_heartbeat: '2026-09-15T00:00:00Z',
      seconds_since_heartbeat: 2,
      detail,
    }
  }

  // A router, because the "no receiver is heartbeating" line links to the
  // Sensors page — where a missing radio is the thing to look at next.
  function renderPlan() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({ component: ChannelPlanView })
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    return render(
      <QueryClientProvider client={client}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- a bare root standing in for the app's registered tree, as sensors.test.tsx does. */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    )
  }

  it('offers no way to edit or record a plan', async () => {
    renderPlan()

    // The recorded plan is still shown -- as figures, not as inputs.
    expect(await screen.findByText('2437 MHz')).toBeVisible()
    expect(screen.queryByLabelText(/Weight for channel/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Record/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument()
    expect(puts).toHaveLength(0)
  })

  // The half an operator can act on: which file each radio loaded. Reported on
  // the sensor's own heartbeat, so it is a measurement rather than a guess at
  // what the deployment is supposed to be running.
  it('shows the plan each receiver reports having loaded', async () => {
    sensors = [
      wifi('wifi-0', { plan: 'channels-primary.yaml' }),
      wifi('wifi-1', { plan: 'channels.yaml', plan_fallback: true }),
    ]
    renderPlan()

    expect(await screen.findByText('channels-primary.yaml')).toBeVisible()
    expect(screen.getByText('channels.yaml')).toBeVisible()
    // A receiver that widened to the full plan says so: its coverage is not
    // the plan anyone wrote down.
    expect(screen.getByText(/Widened to the full plan/)).toBeVisible()
  })

  it('says nothing is loaded rather than implying a plan when no radio is heartbeating', async () => {
    sensors = []
    renderPlan()

    expect(await screen.findByText(/No Wi-Fi receiver is heartbeating/)).toBeVisible()
  })

  // The one action left, and the only one that moves the recorded plan closer
  // to being the real one.
  it('marks the recorded plan as intended and offers it as YAML', async () => {
    renderPlan()

    expect(await screen.findByText(/intended, not applied/)).toBeVisible()
    expect(await screen.findByRole('button', { name: /Copy as YAML/ })).toBeVisible()
  })

  it('does not claim a restart will apply the plan', async () => {
    renderPlan()

    await screen.findByText('2437 MHz')
    expect(
      screen.queryByText(/must be restarted for this to take effect/),
    ).not.toBeInTheDocument()
  })

  // Two receivers, two different files, neither of them this. An operator
  // comparing the table here against what the unit is scanning needs to know
  // where the real plans live before concluding the receiver is broken.
  //
  // Behind the "Why can this page not apply a plan?" disclosure, so the
  // assertion opens it: this is background read once, not a standing banner.
  it('names the files each receiver actually reads', async () => {
    const user = userEvent.setup()
    renderPlan()

    await user.click(await screen.findByText(/Why can this page not apply a plan/))

    expect(screen.getByText('config/channels-primary.yaml')).toBeVisible()
    expect(screen.getByText('config/channels-sweep.yaml')).toBeVisible()
  })
})

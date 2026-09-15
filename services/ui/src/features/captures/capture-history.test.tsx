/**
 * The recordings list, where it now lives.
 *
 * These two cases were written against the Sensors page, which used to render
 * this same list behind `?view=captures`. That pane is gone — `/captures` is
 * a real route and one list needs one home — so the assertions moved here
 * rather than being deleted with the pane: what they pin is how a capture row
 * reads, not which page happened to be showing it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { Capture, CapturesResponse } from '@/lib/api/types'

import { CaptureHistory } from './sensor-captures'

const API = '*/api/v1'

let captures: Capture[] = []

const server = setupServer(
  http.get(`${API}/captures`, () => {
    const body: CapturesResponse = { captures }
    return HttpResponse.json(body)
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  captures = []
})
afterAll(() => server.close())

/**
 * A router, because the rows and the empty state carry `Link`s now — the way
 * to a capture's report, and the way back to the sensor that would start one.
 * A bare render throws on the first `Link` without one.
 */
function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: CaptureHistory })
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

describe('CaptureHistory', () => {
  it('lists a recording with its file and state', async () => {
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
    renderHistory()

    expect(await screen.findByText('wifi-0-capture.pcap')).toBeVisible()
    expect(screen.getByText('completed')).toBeVisible()
  })

  // A failed capture used to render a red badge and nothing else, because the
  // UI's Capture type never declared `error` -- so the API's reason for the
  // failure arrived on every response and was thrown away. scripts/check-mirrors.py
  // now compares the two field lists so the type cannot silently fall behind again.
  it('shows why a capture failed, not just that it did', async () => {
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
    renderHistory()

    expect(await screen.findByText('wifi-0-doomed.pcap')).toBeVisible()
    expect(screen.getByText('failed')).toBeVisible()
    expect(screen.getByText('wlan1 is not in monitor mode')).toBeVisible()
  })

  // "Open Capture settings on a sensor above" was true while this list sat
  // under the sensor list. There is no "above" any more, so the empty state
  // names the page instead of gesturing at one.
  it('points at the Sensors page when there is nothing recorded', async () => {
    captures = []
    renderHistory()

    expect(await screen.findByText('No captures yet')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Sensors' })).toHaveAttribute('href', '/sensors')
  })
})

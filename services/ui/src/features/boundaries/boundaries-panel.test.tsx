/**
 * Only the list view is exercised here, deliberately never the editor: it
 * mounts a real MapLibre `Map`, which needs a WebGL context jsdom does not
 * provide -- the same reason no test in this codebase renders LiveMap.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { BoundariesResponse } from '@/lib/api/types'

import { BoundariesPanel } from './boundaries-panel'

const API = '*/api/v1'

let boundaries: BoundariesResponse = { boundaries: [] }

const server = setupServer(
  http.get(`${API}/admin/boundaries`, () => HttpResponse.json(boundaries)),
  http.delete(`${API}/admin/boundaries/:id`, () => new HttpResponse(null, { status: 204 })),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  boundaries = { boundaries: [] }
})
afterAll(() => server.close())

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <BoundariesPanel />
    </QueryClientProvider>,
  )
}

describe('BoundariesPanel', () => {
  it('shows an empty state when nothing has been drawn', async () => {
    renderPanel()
    expect(await screen.findByText('No boundaries yet')).toBeVisible()
  })

  it('lists a saved boundary by name and vertex count', async () => {
    boundaries = {
      boundaries: [
        {
          boundary_id: 'b1',
          name: 'Back yard',
          points: [
            { lat: 1, lon: 1 },
            { lat: 1, lon: 2 },
            { lat: 2, lon: 2 },
          ],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    }
    renderPanel()

    expect(await screen.findByText('Back yard')).toBeVisible()
    expect(screen.getByText('3 points')).toBeVisible()
  })

  // Deleting silently ends every rule geofenced on it, so it takes the same
  // second click every other destructive action here does.
  it('asks for confirmation before deleting', async () => {
    boundaries = {
      boundaries: [
        {
          boundary_id: 'b1',
          name: 'Back yard',
          points: [
            { lat: 1, lon: 1 },
            { lat: 1, lon: 2 },
            { lat: 2, lon: 2 },
          ],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    }
    renderPanel()
    await screen.findByText('Back yard')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete Back yard' }))

    expect(await screen.findByText('Confirm delete')).toBeVisible()
    // Nothing has actually gone out yet.
    expect(screen.getByText('Back yard')).toBeVisible()
  })
})

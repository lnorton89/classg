import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { RecordingIndicator } from './recording-indicator'

const API = '*/api/v1'

let state = { enabled: true, since: '2026-08-11T04:00:00Z', discarded_while_paused: 0 }

const server = setupServer(
  http.get(`${API}/monitoring`, () => HttpResponse.json(state)),
  http.put(`${API}/monitoring`, async ({ request }) => {
    const body = (await request.json()) as { enabled: boolean; reason?: string }
    state = {
      ...state,
      enabled: body.enabled,
      ...(body.reason ? { reason: body.reason } : {}),
    }
    return HttpResponse.json(state)
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  state = { enabled: true, since: '2026-08-11T04:00:00Z', discarded_while_paused: 0 }
})
afterAll(() => server.close())

function renderIndicator() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <RecordingIndicator />
    </QueryClientProvider>,
  )
}

describe('RecordingIndicator', () => {
  it('shows recording without anyone having asked for it', async () => {
    renderIndicator()
    expect(await screen.findByText('Recording')).toBeInTheDocument()
  })

  it('requires confirmation before stopping', async () => {
    // Stopping a detector is the one control here whose cost is invisible
    // until you need data you did not keep, so it must not be a bare toggle.
    const user = userEvent.setup()
    renderIndicator()

    await user.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    // Still recording: asking is not doing.
    expect(screen.getByText('Recording')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Recording')).toBeInTheDocument()
  })

  it('pauses after confirmation and offers resume', async () => {
    const user = userEvent.setup()
    renderIndicator()

    await user.click(await screen.findByRole('button', { name: 'Pause' }))
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))

    expect(await screen.findByText('Paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  it('shows how much was discarded, so paused never looks like quiet', async () => {
    state = {
      enabled: false,
      since: '2026-08-11T04:00:00Z',
      discarded_while_paused: 1234,
    }
    renderIndicator()
    expect(await screen.findByText('Paused')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/1,234 discarded/)).toBeInTheDocument())
  })

  it('announces state changes to assistive tech', async () => {
    renderIndicator()
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Recording')
  })
})

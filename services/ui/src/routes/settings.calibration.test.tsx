import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SettingsResponse } from '@/lib/api/types'

import { ReceiverPositionEditor } from './settings.calibration'

const API = '*/api/v1'

const settings: SettingsResponse = {
  settings: {
    'map.receiver_position': {
      value: { lat: 51.4775, lon: -0.0014 },
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
  http.put(`${API}/config/settings`, async ({ request }) => {
    puts.push((await request.json()) as Record<string, string>)
    return HttpResponse.json({ restart_required: false })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  puts = []
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

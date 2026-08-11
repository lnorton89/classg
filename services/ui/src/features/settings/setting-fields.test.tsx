/**
 * The settings controls, against the MSW registry.
 *
 * These pin the two behaviours that are easy to get subtly wrong and invisible
 * when you do: that an env-held value cannot be edited, and that Save sends
 * only what actually changed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SettingsGroup } from './setting-fields'

// This file owns its server, as monitoring.test.tsx does: each suite states the
// exact registry response it is reasoning about rather than sharing a fixture
// whose shape it does not control.
const API = '*/api/v1'
const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  vi.restoreAllMocks()
})
afterAll(() => server.close())

function wrap(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const FIELDS = [
  { key: 'fusion.net_adsb', label: 'Poll a network aggregator', kind: 'switch' as const },
  { key: 'fusion.net_adsb_radius_nm', label: 'Radius (nm)', kind: 'number' as const },
]

describe('SettingsGroup', () => {
  it('renders the registry value and the registry doc', async () => {
    server.use(
      http.get(`${API}/config/settings`, () =>
        HttpResponse.json({
          settings: {
            'fusion.net_adsb': {
              value: false,
              source: 'db',
              mutable: true,
              doc: 'poll a network ADS-B aggregator',
            },
            'fusion.net_adsb_radius_nm': { value: 25, source: 'db', mutable: true },
          },
          env_overridden: [],
        }),
      ),
    )
    wrap(<SettingsGroup fields={FIELDS} />)

    expect(await screen.findByDisplayValue('25')).toBeInTheDocument()
    // Help text comes from the API rather than being retyped in the component,
    // so that it cannot drift from the value it describes.
    expect(screen.getByText('poll a network ADS-B aggregator')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Poll a network aggregator' })).not.toBeChecked()
  })

  // ADR-0007: an env override wins, so a control that accepted a change would
  // be promising something the process will ignore.
  it('locks a value held in the environment, and says why', async () => {
    const put = vi.fn()
    server.use(
      http.get(`${API}/config/settings`, () =>
        HttpResponse.json({
          settings: {
            'fusion.net_adsb': { value: true, source: 'env', mutable: true },
            'fusion.net_adsb_radius_nm': { value: 40, source: 'env', mutable: true },
          },
          env_overridden: ['fusion.net_adsb', 'fusion.net_adsb_radius_nm'],
        }),
      ),
      http.put(`${API}/config/settings`, async ({ request }) => {
        put(await request.json())
        return HttpResponse.json({ restart_required: false })
      }),
    )
    const user = userEvent.setup()
    wrap(<SettingsGroup fields={FIELDS} />)

    expect(await screen.findByDisplayValue('40')).toBeDisabled()
    // Base UI's switch marks itself with aria-disabled and tabindex rather than
    // the native attribute, so assert what an operator would actually hit: the
    // control does not move, and nothing is sent.
    const toggle = screen.getByRole('switch', { name: 'Poll a network aggregator' })
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await user.click(toggle)
    expect(toggle).toBeChecked()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    expect(put).not.toHaveBeenCalled()

    expect(screen.getAllByText(/Held in the environment/).length).toBeGreaterThan(0)
  })

  it('saves only the fields that changed', async () => {
    const put = vi.fn()
    server.use(
      http.get(`${API}/config/settings`, () =>
        HttpResponse.json({
          settings: {
            'fusion.net_adsb': { value: false, source: 'db', mutable: true },
            'fusion.net_adsb_radius_nm': { value: 25, source: 'db', mutable: true },
          },
          env_overridden: [],
        }),
      ),
      http.put(`${API}/config/settings`, async ({ request }) => {
        put(await request.json())
        return HttpResponse.json({ restart_required: false })
      }),
    )
    const user = userEvent.setup()
    wrap(<SettingsGroup fields={FIELDS} />)

    const save = await screen.findByRole('button', { name: /save/i })
    expect(save).toBeDisabled()

    await user.click(screen.getByRole('switch', { name: 'Poll a network aggregator' }))
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => expect(put).toHaveBeenCalled())
    // The untouched radius must not be echoed back: a PUT that resends every
    // field turns a no-op into a write, and a write into an audit entry.
    expect(put).toHaveBeenCalledWith({ 'fusion.net_adsb': 'true' })
  })

  // The API serves the RUNNING config, so a saved value does not come back in
  // the refetch. Found against the live API: clearing the draft on success made
  // the toggle spring back to its old position, which reads as a failed save.
  it('keeps a saved value on screen and says it is not running yet', async () => {
    server.use(
      http.get(`${API}/config/settings`, () =>
        HttpResponse.json({
          settings: {
            'fusion.net_adsb': { value: false, source: 'db', mutable: true },
            'fusion.net_adsb_radius_nm': { value: 25, source: 'db', mutable: true },
          },
          env_overridden: [],
        }),
      ),
      // Deliberately still reporting the old value, as the real API does.
      http.put(`${API}/config/settings`, () =>
        HttpResponse.json({ value: { 'fusion.net_adsb': 'true' }, restart_required: true }),
      ),
    )
    const user = userEvent.setup()
    wrap(<SettingsGroup fields={FIELDS} />)

    const toggle = await screen.findByRole('switch', { name: 'Poll a network aggregator' })
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByText(/not running yet/i)).toBeInTheDocument()
    // The control must not revert to what the process is still using.
    expect(toggle).toBeChecked()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  // A switch has no FormField wrapper to carry an error, so it has to render
  // one itself. Found by driving the real page: a rejected boolean failed
  // completely silently — the save did nothing and the page looked unchanged.
  it('shows a rejected boolean next to its switch', async () => {
    server.use(
      http.get(`${API}/config/settings`, () =>
        HttpResponse.json({
          settings: {
            'fusion.net_adsb': { value: false, source: 'db', mutable: true },
            'fusion.net_adsb_radius_nm': { value: 25, source: 'db', mutable: true },
          },
          env_overridden: [],
        }),
      ),
      http.put(`${API}/config/settings`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'invalid_parameter',
              message: 'receiver position is unset; the feed cannot start',
              field: 'fusion.net_adsb',
            },
          },
          { status: 400 },
        ),
      ),
    )
    const user = userEvent.setup()
    wrap(<SettingsGroup fields={FIELDS} />)

    await user.click(await screen.findByRole('switch', { name: 'Poll a network aggregator' }))
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/receiver position is unset/)
  })

  it('puts a rejected value next to the field that caused it', async () => {
    server.use(
      http.get(`${API}/config/settings`, () =>
        HttpResponse.json({
          settings: {
            'fusion.net_adsb': { value: false, source: 'db', mutable: true },
            'fusion.net_adsb_radius_nm': { value: 25, source: 'db', mutable: true },
          },
          env_overridden: [],
        }),
      ),
      http.put(`${API}/config/settings`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'invalid_parameter',
              message: 'radius 500 nm exceeds the 250 nm maximum',
              field: 'fusion.net_adsb_radius_nm',
            },
          },
          { status: 400 },
        ),
      ),
    )
    const user = userEvent.setup()
    wrap(<SettingsGroup fields={FIELDS} />)

    const radius = await screen.findByDisplayValue('25')
    await user.clear(radius)
    await user.type(radius, '500')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByText(/exceeds the 250 nm maximum/)).toBeInTheDocument()
    expect(radius).toHaveAttribute('aria-invalid', 'true')
  })
})

/**
 * A webhook is the only path out of this unit that reaches somebody else's
 * server, and what rides on it is decided by a switch on a different page.
 *
 * `api.expose_operator_location` reads as "include the operator position in
 * responses". An admin wiring a rule up to a chat webhook has no reason to
 * connect that sentence to the pilot's ground position leaving the box, so the
 * form says it where the URL is typed rather than leaving it to
 * docs/research/06-legal-and-ethics.md.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { ToastProvider } from '@/components/ui/toast-primitives'
import type {
  BoundariesResponse,
  HookEventDoc,
  HookRule,
  SettingsResponse,
} from '@/lib/api/types'

import { RuleEditor } from './hooks-panel'

const API = '*/api/v1'

/** Nothing to do when the editor closes; the test is done by then. */
function noop(): void {
  return
}

let exposeOperator: unknown = true

const server = setupServer(
  http.get(`${API}/config/settings`, () => {
    const body: SettingsResponse = {
      settings: {
        'api.expose_operator_location': {
          value: exposeOperator,
          source: 'db',
          mutable: true,
        },
      },
      env_overridden: [],
    }
    return HttpResponse.json(body)
  }),
  // The editor's boundary picker fetches this unconditionally; empty is a
  // real, common answer (no boundaries drawn yet) rather than a special case.
  http.get(`${API}/admin/boundaries`, () => {
    const body: BoundariesResponse = { boundaries: [] }
    return HttpResponse.json(body)
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  exposeOperator = true
})
afterAll(() => server.close())

const EVENTS: HookEventDoc[] = [
  {
    event: 'track.confirmed',
    description: 'a track reached CONFIRMED',
    supports_boundary: true,
  },
  {
    event: 'detection.created',
    description: 'every detection',
    supports_boundary: false,
  },
]

function renderEditor(rule?: HookRule) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RuleEditor rule={rule} events={EVENTS} smtpConfigured={false} onDone={noop} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

const RULE_ON_DETECTION: HookRule = {
  rule_id: 'r1',
  name: 'x',
  enabled: true,
  event: 'detection.created',
  cooldown_s: 300,
  action: 'webhook',
  config: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  fire_count: 0,
}

describe('RuleEditor', () => {
  it('names the pilot position among what a webhook sends, while it is exposed', async () => {
    renderEditor()

    expect(await screen.findByText('What this sends')).toBeVisible()
    expect(await screen.findByText('operator_lat')).toBeVisible()
    expect(screen.getByText('operator_lon')).toBeVisible()
  })

  it('says the pilot position is not included once it is switched off', async () => {
    exposeOperator = false
    renderEditor()

    expect(await screen.findByText('What this sends')).toBeVisible()
    expect(await screen.findByText(/pilot.s ground position is not included/)).toBeVisible()
    expect(screen.queryByText('operator_lat')).not.toBeInTheDocument()
  })

  // The settings store is stringly typed underneath the API's boolean, and a
  // reader that only accepts one shape under-warns on the other -- which for
  // this particular sentence means saying a position is withheld while it is
  // being sent.
  it('reads the switch whether it arrives as a boolean or a string', async () => {
    exposeOperator = 'true'
    renderEditor()

    expect(await screen.findByText('operator_lat')).toBeVisible()
  })

  // A boundary condition needs a position, and detection.created never
  // carries one -- offering the field there would let an admin build a rule
  // that looks configured and can never fire.
  it('offers the within-boundary condition for an event that carries a position', async () => {
    renderEditor()
    expect(await screen.findByRole('combobox', { name: 'Within boundary' })).toBeVisible()
  })

  it('hides the within-boundary condition for an event with no position', async () => {
    renderEditor(RULE_ON_DETECTION)
    await screen.findByText('What this sends')
    expect(screen.queryByRole('combobox', { name: 'Within boundary' })).not.toBeInTheDocument()
  })
})

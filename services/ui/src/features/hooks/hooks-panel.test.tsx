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
import type { HookEventDoc, SettingsResponse } from '@/lib/api/types'

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
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  exposeOperator = true
})
afterAll(() => server.close())

const EVENTS: HookEventDoc[] = [
  { event: 'track.confirmed', description: 'a track reached CONFIRMED' },
]

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RuleEditor events={EVENTS} smtpConfigured={false} onDone={noop} />
      </ToastProvider>
    </QueryClientProvider>,
  )
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
})

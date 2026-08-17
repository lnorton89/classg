import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { AuthMe } from '@/lib/api/types'

type ApiClientModule = typeof ApiClient

import { AuthGate } from './auth-gate'

const authMe = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, authMe, login: vi.fn(), setupFirstAdmin: vi.fn() } }
})

function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthGate>
        <p>the application</p>
      </AuthGate>
    </QueryClientProvider>,
  )
}

function me(overrides: Partial<AuthMe> = {}): AuthMe {
  return {
    authenticated: false,
    auth_enabled: true,
    setup_required: false,
    ...overrides,
  }
}

beforeEach(() => {
  authMe.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuthGate', () => {
  it('shows the setup screen on a unit with no accounts', async () => {
    // The trap this guards: a fresh unit that renders a login form leaves the
    // operator typing credentials that cannot exist yet.
    authMe.mockResolvedValue(me({ setup_required: true }))
    renderGate()

    await waitFor(() => expect(screen.getByText(/Set up this receiver/)).toBeInTheDocument())
    expect(screen.queryByText('the application')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Sign in$/ })).not.toBeInTheDocument()
  })

  it('shows the login screen when nobody is signed in', async () => {
    authMe.mockResolvedValue(me())
    renderGate()

    await waitFor(() => expect(screen.getByLabelText(/Username/)).toBeInTheDocument())
    expect(screen.queryByText('the application')).not.toBeInTheDocument()
    expect(screen.queryByText(/Set up this receiver/)).not.toBeInTheDocument()
  })

  it('renders the app once someone is signed in', async () => {
    authMe.mockResolvedValue(
      me({
        authenticated: true,
        user: {
          user_id: 'u1',
          username: 'lee',
          role: 'operator',
          disabled: false,
          created_at: '2026-08-17T12:00:00Z',
          updated_at: '2026-08-17T12:00:00Z',
        },
      }),
    )
    renderGate()

    await waitFor(() => expect(screen.getByText('the application')).toBeInTheDocument())
  })

  it('renders the app when authentication is disabled', async () => {
    // ModeOff: the API treats every request as an admin, so a UI that demanded
    // a login would be unusable against a box that wants none.
    authMe.mockResolvedValue(me({ auth_enabled: false }))
    renderGate()

    await waitFor(() => expect(screen.getByText('the application')).toBeInTheDocument())
  })

  it('says the API is unreachable rather than asking for a password', async () => {
    // A dead API is not a sign-in problem, and a login form here would have
    // someone typing a password at a server that is not answering.
    authMe.mockRejectedValue(new Error('network down'))
    renderGate()

    await waitFor(() =>
      expect(screen.getByText(/The API is not answering/)).toBeInTheDocument(),
    )
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument()
  })

  it('surfaces an SSO failure passed back in the query string', async () => {
    // A plain object rather than a spread of window.location: Location is a
    // class instance and spreading it drops its prototype.
    vi.stubGlobal('location', {
      href: 'http://localhost/',
      origin: 'http://localhost',
      pathname: '/',
      search: '?error=no+account+on+this+unit+is+linked+to+that+identity',
      hash: '',
    })
    authMe.mockResolvedValue(me())
    renderGate()

    await waitFor(() =>
      expect(screen.getByText(/no account on this unit is linked/i)).toBeInTheDocument(),
    )
  })

  it('offers an SSO button only when a provider is configured', async () => {
    authMe.mockResolvedValue(me())
    const { unmount } = renderGate()
    await waitFor(() => expect(screen.getByLabelText(/Username/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Company SSO/ })).not.toBeInTheDocument()
    unmount()

    authMe.mockResolvedValue(me({ providers: [{ id: 'oidc', label: 'Company SSO' }] }))
    renderGate()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Company SSO' })).toBeInTheDocument(),
    )
  })
})

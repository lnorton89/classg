import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { AuthMe } from '@/lib/api/types'

import { AppShell } from './app-shell'

type ApiClientModule = typeof ApiClient

const authMe = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, authMe } }
})

// The shell links with TanStack Router. The gate short-circuits before any of
// that renders when signed out, which is the case under test.
vi.mock('@tanstack/react-router', () => ({
  // A span, not an anchor: an <a> with no href fails jsx-a11y, and nothing
  // here clicks a link — the gate short-circuits before any of them render.
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useRouter: () => ({ history: { back: vi.fn(), push: vi.fn() } }),
  useRouterState: () => ({ location: { pathname: '/' } }),
}))

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <AppShell>
        <p>signed-in content</p>
      </AppShell>
    </QueryClientProvider>,
  )
}

function me(overrides: Partial<AuthMe> = {}): AuthMe {
  return { authenticated: false, auth_enabled: true, setup_required: false, ...overrides }
}

beforeEach(() => authMe.mockReset())

describe('AppShell before sign-in', () => {
  /**
   * The leak this pins. The gate used to sit inside <main>, so a signed-out
   * visitor got the full header: system health, sensor state, stream status,
   * whether the unit was recording, the whole navigation, a command palette
   * over everything the app knows — and TrackAlerts, which pops live drone
   * detections as toasts.
   *
   * A login page must leak nothing.
   */
  it('renders no navigation, status or chrome', async () => {
    authMe.mockResolvedValue(me())
    renderShell()

    await waitFor(() => expect(screen.getByLabelText(/Username/)).toBeInTheDocument())

    // No navigation — the app's structure is itself information.
    expect(screen.queryByRole('navigation', { name: /Primary/i })).not.toBeInTheDocument()
    for (const label of ['Live', 'Tracks', 'Sensors', 'Logs', 'Docs', 'Spectrum']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }

    // No status surfaces, no settings, no account controls.
    for (const label of [/Settings/i, /Sign out/i, /Search/i, /Command/i]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument()
    }

    // And no route content leaked through the gate.
    expect(screen.queryByText('signed-in content')).not.toBeInTheDocument()
  })

  it('renders the setup screen with the same absence of chrome', async () => {
    authMe.mockResolvedValue(me({ setup_required: true }))
    renderShell()

    await waitFor(() => expect(screen.getByText(/Set up this receiver/)).toBeInTheDocument())
    expect(screen.queryByRole('navigation', { name: /Primary/i })).not.toBeInTheDocument()
    expect(screen.queryByText('signed-in content')).not.toBeInTheDocument()
  })

  // The signed-in render is covered by auth-gate.test.tsx. Reproducing it here
  // would mean mocking enough of the router for every nav link and status pill
  // to render, which tests the mock more than the shell. This file exists for
  // the ABSENCE of chrome before sign-in.
})

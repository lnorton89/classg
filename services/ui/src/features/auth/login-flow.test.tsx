import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { AuthMe } from '@/lib/api/types'

import { LoginScreen } from './login-screen'

type ApiClientModule = typeof ApiClient

const login = vi.hoisted(() => vi.fn())
const routerInvalidate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, login } }
})

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: routerInvalidate }),
}))

const signedIn: AuthMe = {
  authenticated: true,
  auth_enabled: true,
  setup_required: false,
  user: {
    user_id: 'u1',
    username: 'claude',
    display_name: 'Claude',
    role: 'admin',
    disabled: false,
    created_at: '2026-08-18T05:00:00Z',
    updated_at: '2026-08-18T05:00:00Z',
  },
}

beforeEach(() => {
  login.mockReset().mockResolvedValue(signedIn)
  routerInvalidate.mockReset()
})

/**
 * The bug this pins, seen on the unit: signing in landed on a red box reading
 * "API error: unauthenticated — log in to continue", with a Retry button, on a
 * page the operator was now authenticated for.
 *
 * Route loaders run before the auth gate renders, so opening the console
 * signed out threw a 401 that the router's error boundary caught and kept.
 * `invalidateQueries` does not re-run a loader, so nothing cleared it.
 */
describe('signing in', () => {
  it('re-runs the route loaders, not just the query cache', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries')

    render(
      <QueryClientProvider client={client}>
        <LoginScreen />
      </QueryClientProvider>,
    )

    await userEvent.type(screen.getByLabelText(/username/i), 'claude')
    await userEvent.type(screen.getByLabelText(/password/i), 'a-password')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(login).toHaveBeenCalledOnce())
    // Both, and the router one is the half that was missing.
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled())
    await waitFor(() => expect(routerInvalidate).toHaveBeenCalled())
  })

  // The API answers a wrong username and a wrong password identically to
  // defend against account enumeration; repeating its message rather than
  // improving on it is what keeps that defence intact from this end.
  it("shows the API's own message and nothing more helpful", async () => {
    const { ApiError } = await import('@/lib/api/client')
    login.mockRejectedValue(new ApiError(401, 'unauthenticated', 'invalid credentials'))

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={client}>
        <LoginScreen />
      </QueryClientProvider>,
    )

    await userEvent.type(screen.getByLabelText(/username/i), 'claude')
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument())
    expect(screen.queryByText(/no such user/i)).not.toBeInTheDocument()
    expect(routerInvalidate).not.toHaveBeenCalled()
  })
})

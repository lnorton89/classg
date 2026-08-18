/**
 * Same reasoning as sensors.test.tsx: the selected category is now
 * `Route.useSearch()` state, so this needs a real (minimal) router rather
 * than a mocked one, and a `createRoute` standing in for the file route
 * because `createFileRoute` leaves `getParentRoute` unset outside the real
 * build (vitest.config.ts skips the router plugin on purpose).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRoute,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { adminSearchSchema, AdminRoute } from './admin'

const API = '*/api/v1'

const server = setupServer(
  http.get(`${API}/auth/me`, () =>
    HttpResponse.json({ authenticated: true, auth_enabled: false, setup_required: false }),
  ),
  http.get(`${API}/admin/users`, () => HttpResponse.json({ users: [] })),
  http.get(`${API}/admin/sessions`, () => HttpResponse.json({ sessions: [] })),
  http.get(`${API}/admin/deployment`, () =>
    HttpResponse.json({ configured: false, reason: 'test' }),
  ),
  http.get(`${API}/admin/deployment/history`, () =>
    HttpResponse.json({ configured: false, reason: 'test', runs: [] }),
  ),
  http.get(`${API}/admin/watchdog`, () =>
    HttpResponse.json({ configured: false, reason: 'test' }),
  ),
  http.get(`${API}/admin/hooks`, () =>
    HttpResponse.json({ rules: [], events: [], smtp_configured: false }),
  ),
  http.get(`${API}/admin/hook-deliveries`, () =>
    HttpResponse.json({ deliveries: [], dropped: 0 }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function renderPage(initialPath = '/admin') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => <Outlet />,
  })
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    validateSearch: adminSearchSchema,
    component: AdminRoute,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([adminRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: { queryClient: client },
  })
  const result = render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- test-only route tree, not the app's registered one. */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { ...result, router }
}

describe('AdminRoute', () => {
  it('defaults to Access', async () => {
    renderPage()
    expect(await screen.findByText('Accounts')).toBeVisible()
  })

  it('switching category updates the URL, and the URL restores the category', async () => {
    const user = userEvent.setup()
    const { router } = renderPage()

    await screen.findByText('Accounts')
    await user.click(screen.getByRole('button', { name: /This unit/ }))

    expect(await screen.findByText(/Drag card handles/)).toBeVisible()
    expect(router.state.location.search).toEqual({ section: 'unit' })

    await user.click(screen.getByRole('button', { name: /Outbound/ }))
    expect(await screen.findByText('Alert rules')).toBeVisible()
    expect(router.state.location.search).toEqual({ section: 'outbound' })
  })

  it('opening a URL with a section already selected shows that section, not Access', async () => {
    renderPage('/admin?section=outbound')
    expect(await screen.findByText('Alert rules')).toBeVisible()
    expect(screen.queryByText('Accounts')).not.toBeInTheDocument()
  })
})

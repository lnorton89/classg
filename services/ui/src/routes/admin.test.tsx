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

    expect(await screen.findByText('Deployment')).toBeVisible()
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

  /**
   * The three unit panels were a drag-to-reorder grid, remembered per browser,
   * which meant every layout was equally endorsed — including the ones that
   * put the deploy history above the button that deploys. The order is fixed
   * now, and it is the order of the question: is this unit current, is it
   * repairing itself, what has it done before.
   */
  it('shows the unit panels in a fixed order, with Deployment as the one primary card', async () => {
    renderPage('/admin?section=unit')

    // Each panel skeletons until its own query lands, so wait for the slowest
    // before reading the order — otherwise this asserts on whichever arrived
    // first, which is the very thing being pinned.
    await screen.findByRole('heading', { name: 'Deployment' })
    await screen.findByRole('heading', { name: 'Self-repair' })
    const headings = screen.getAllByRole('heading', {
      name: /Deployment|Self-repair|Deploy history/,
    })
    expect(headings.map((node) => node.textContent.trim())).toEqual([
      'Deployment',
      'Self-repair',
      'Deploy history',
    ])

    // No handle to drag, and nothing offering to put the layout back.
    expect(screen.queryByText(/Drag card handles/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reset layout/i })).not.toBeInTheDocument()

    const primaries = document.querySelectorAll('[data-card-weight="primary"]')
    expect(primaries).toHaveLength(1)
    expect(primaries[0]?.textContent).toContain('Deployment')
  })
})

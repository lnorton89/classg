/**
 * The rail and the tabs, rendered.
 *
 * `nav-items.test.ts` covers which entry a URL belongs to; this covers that
 * the answer reaches the screen — as `aria-current="page"`, which is the part
 * a keyboard or screen-reader user has instead of the accent bar.
 *
 * A real (minimal) router rather than a mocked one, for the same reason
 * sensors.test.tsx uses one: the active entry is derived from the location,
 * and a mocked location tests the mock.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { BottomTabs } from './bottom-tabs'
import { SideRail } from './side-rail'

function Harness({ isAdmin }: { isAdmin: boolean }) {
  const [moreOpen, setMoreOpen] = useState(false)
  return (
    <>
      <SideRail isAdmin={isAdmin} />
      <BottomTabs isAdmin={isAdmin} moreOpen={moreOpen} onMoreOpenChange={setMoreOpen} />
    </>
  )
}

function renderNav(path = '/', { isAdmin = false } = {}) {
  const rootRoute = createRootRoute({ component: () => <Harness isAdmin={isAdmin} /> })
  // Enough of the tree for the links to resolve; the components under test do
  // not render any route's own content.
  const children = ['/', '/tracks', '/sensors', '/spectrum', '/captures', '/logs'].map((p) =>
    createRoute({ getParentRoute: () => rootRoute, path: p, component: () => null }),
  )
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  // The "More" sheet carries the search box, which reads the query cache.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- test-only route tree, not the app's registered one. */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

// Awaited: the router mounts its tree asynchronously, so a synchronous query
// runs against an empty body.
function rail() {
  return screen.findByRole('navigation', { name: 'Primary' })
}

function tabs() {
  return screen.findByRole('navigation', { name: 'Primary tabs' })
}

describe('the desktop rail', () => {
  it('carries every destination, not four with the rest behind a gear', async () => {
    renderNav()
    const links = within(await rail()).getAllByRole('link')
    expect(links.map((link) => link.textContent.trim())).toEqual([
      'Live',
      'Flights',
      'Sensors',
      'Spectrum',
      'Captures',
      'Event log',
      'Settings',
    ])
  })

  it('adds Administration for an administrator', async () => {
    renderNav('/', { isAdmin: true })
    expect(within(await rail()).getByRole('link', { name: 'Administration' })).toBeVisible()
  })

  it('leaves Administration out for everyone else', async () => {
    // Offering a viewer a destination that renders "you need the
    // administrator role" is noise, not discoverability.
    renderNav()
    expect(within(await rail()).queryByRole('link', { name: 'Administration' })).toBeNull()
  })

  it('marks the current page, and only it', async () => {
    renderNav('/spectrum')
    const current = within(await rail()).getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('Spectrum')
  })

  it('marks exactly one entry on a route two entries used to share', async () => {
    // Captures is its own route rather than `/sensors?view=captures` because
    // the router's own aria-current cannot be overridden: two entries pointing
    // at one path lit both.
    renderNav('/captures')
    const current = within(await rail()).getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('Captures')
  })

  it('collapses to icons, keeping every label in the accessible name', async () => {
    const user = userEvent.setup()
    renderNav()
    await user.click(await screen.findByRole('button', { name: /Collapse the navigation/ }))

    // The picture loses the words; the name must not, or a collapsed rail of
    // nine unnamed icons is a quiz.
    expect(within(await rail()).getByRole('link', { name: 'Spectrum' })).toBeVisible()
    expect(screen.getByRole('button', { name: /Expand the navigation/ })).toBeVisible()
  })
})

describe('the phone tabs', () => {
  it('shows the daily destinations and a More', async () => {
    renderNav()
    const bar = await tabs()
    const labels = [
      ...within(bar)
        .getAllByRole('link')
        .map((el) => el.textContent.trim()),
      ...within(bar)
        .getAllByRole('button')
        .map((el) => el.textContent.trim()),
    ]
    expect(labels).toEqual(['Live', 'Flights', 'Sensors', 'More'])
  })

  it('marks More as the current place when the page is one of the others', async () => {
    renderNav('/logs')
    const more = within(await tabs()).getByRole('button', { name: 'More' })
    // Otherwise the bar claims the operator is nowhere.
    expect(more).toHaveAttribute('aria-current', 'page')
  })

  it('opens a sheet with the destinations the bar cannot hold, plus search', async () => {
    const user = userEvent.setup()
    renderNav()
    await user.click(within(await tabs()).getByRole('button', { name: 'More' }))

    const sheet = await screen.findByRole('dialog')
    for (const label of ['Spectrum', 'Captures', 'Event log', 'Settings']) {
      expect(within(sheet).getByRole('link', { name: new RegExp(label) })).toBeVisible()
    }
    expect(
      within(sheet).getByRole('combobox', { name: /Search flights, aircraft and sensors/ }),
    ).toBeVisible()
  })
})

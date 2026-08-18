import { render, screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import guide from '../../../../../docs/operator-guide.json'
import { DocsDocument } from './$docId'
import { DocsTree } from '../docs'

function renderInRouter(component: ReactNode) {
  const rootRoute = createRootRoute()
  const testRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([testRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  return render(<RouterProvider router={router} />)
}

describe('documentation routes', () => {
  it('renders repository paths as a documentation tree', async () => {
    renderInRouter(<DocsTree />)

    expect(await screen.findByText('classg/')).toBeVisible()
    expect(screen.getByText('services/')).toBeVisible()
    expect(screen.getByRole('link', { name: 'sensor-wifi' })).toHaveAttribute(
      'href',
      '/docs/sensor-wifi',
    )
    expect(screen.getByRole('link', { name: 'api' })).toHaveAttribute('href', '/docs/api')
    expect(screen.getByRole('link', { name: 'ui' })).toHaveAttribute('href', '/docs/ui')
    expect(screen.queryByRole('link', { name: 'Architecture' })).not.toBeInTheDocument()
  })

  it('renders one component as a standalone page', async () => {
    const document = guide.documents.find((candidate) => candidate.id === 'api')
    expect(document).toBeDefined()
    if (!document) return

    renderInRouter(<DocsDocument document={document} />)

    expect(await screen.findByRole('heading', { name: 'Go API' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Architecture' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Environment variables' })).toBeVisible()
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings.at(-1)).toBe('Environment variables')
    expect(screen.getByText(/go run \.\/cmd\/classg-api/)).toBeVisible()
    expect(screen.getByText('docs/architecture/api-contract.md')).toBeVisible()
  })
})

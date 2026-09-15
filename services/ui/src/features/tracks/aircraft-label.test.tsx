/**
 * The role gate on the label control.
 *
 * None of this is the security — the API refuses the PUT whatever the browser
 * renders (features/auth/use-auth.ts). What it protects is the operator's
 * trust in the interface: a viewer offered an "Edit label" button that opens a
 * form and then fails on Save learns that this console's controls are
 * decorative, and that lesson generalises to the ones that matter.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/ui/toast-primitives'
import type { Role } from '@/lib/api/types'

import { AircraftFlagBadge, AircraftLabelControl } from './aircraft-label'

const hasRole = vi.hoisted(() => vi.fn<(need: Role) => boolean>())

vi.mock('@/features/auth/use-auth', () => ({
  useHasRole: (need: Role) => hasRole(need),
  useAuth: () => undefined,
}))

vi.mock('./use-aircraft-label', () => ({
  useAircraftLabel: () => null,
}))

function mount(role: Role | null) {
  hasRole.mockImplementation((need) => {
    if (role === null) return false
    const rank = { viewer: 1, operator: 2, admin: 3 }
    return rank[role] >= rank[need]
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AircraftLabelControl serial="1581F3YTBJ9H003045J0" />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('AircraftLabelControl', () => {
  it('offers the control to an operator', () => {
    mount('operator')
    expect(screen.getByRole('button', { name: 'Label' })).toBeVisible()
  })

  it('offers it to an admin too, since the roles are ranked', () => {
    mount('admin')
    expect(screen.getByRole('button', { name: 'Label' })).toBeVisible()
  })

  it('hides the edit affordance from a viewer entirely', () => {
    const { container } = mount('viewer')
    expect(screen.queryByRole('button', { name: 'Label' })).toBeNull()
    // Not merely disabled: there is nothing to hover, nothing to explain.
    expect(container).toBeEmptyDOMElement()
  })

  it('hides it while no session has resolved', () => {
    mount(null)
    expect(screen.queryByRole('button', { name: 'Label' })).toBeNull()
  })

  it('opens a form seeded empty for an unlabelled aircraft', async () => {
    const user = userEvent.setup()
    mount('operator')

    await user.click(screen.getByRole('button', { name: 'Label' }))

    const field = await screen.findByLabelText('Label')
    expect(field).toHaveValue('')
    // No Clear on an aircraft that has no label to clear.
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })
})

describe('AircraftFlagBadge', () => {
  it('renders nothing for an unflagged aircraft', () => {
    const { container } = render(<AircraftFlagBadge flag="" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the flag rather than relying on its colour', () => {
    render(<AircraftFlagBadge flag="watch" />)
    expect(screen.getByText('watch')).toBeVisible()
  })
})

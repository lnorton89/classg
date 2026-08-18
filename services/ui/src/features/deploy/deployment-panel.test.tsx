import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { DeploymentStatus } from '@/lib/api/types'

type ApiClientModule = typeof ApiClient

import { DeploymentPanel } from './deployment-panel'

const deployment = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return {
    ...actual,
    api: { ...actual.api, deployment, requestDeploy: vi.fn(), cancelDeploy: vi.fn() },
  }
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <DeploymentPanel />
    </QueryClientProvider>,
  )
}

function status(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    configured: true,
    commit: 'f30b354d3bc1a433a16dab0e1a1c9363a5f7bcbc',
    commit_subject: 'Deploy main to the unit itself',
    remote_commit: 'f30b354d3bc1a433a16dab0e1a1c9363a5f7bcbc',
    remote_ci: 'success',
    last_check_at: new Date().toISOString(),
    last_result: 'up-to-date',
    timer_enabled: true,
    update_available: false,
    deploy_requested: false,
    state_age_s: 60,
    ...overrides,
  }
}

beforeEach(() => deployment.mockReset())

describe('DeploymentPanel', () => {
  it('reports an unconfigured unit as information, not an error', async () => {
    deployment.mockResolvedValue({
      configured: false,
      reason: 'the deploy script has not run yet on this unit',
      update_available: false,
      deploy_requested: false,
    })
    renderPanel()

    await waitFor(() =>
      expect(screen.getByText(/No deploy agent on this unit/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/has not run yet/)).toBeInTheDocument()
  })

  // The button must not imply the API is deploying. It writes a request marker;
  // the host agent acts on its own schedule.
  it('says a deploy is requested, never that it is happening now', async () => {
    deployment.mockResolvedValue(status({ update_available: true }))
    renderPanel()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Request deploy/ })).toBeInTheDocument(),
    )
    expect(screen.getByText(/not immediate/i)).toBeInTheDocument()
    expect(screen.queryByText(/^Deploying/)).not.toBeInTheDocument()
  })

  it('explains what a queued deploy still will not do', async () => {
    deployment.mockResolvedValue(status({ deploy_requested: true }))
    renderPanel()

    await waitFor(() => expect(screen.getByText(/deploy queued/)).toBeInTheDocument())
    // The gates still apply — the button raises a hand, it does not override.
    expect(screen.getByText(/refuses if CI is not green/)).toBeInTheDocument()
  })

  // The most useful failure this panel can surface: the flag says the timer is
  // on, and the agent has not actually run in hours.
  it('warns when the agent has not checked in, even with the timer enabled', async () => {
    deployment.mockResolvedValue(status({ timer_enabled: true, state_age_s: 4 * 3600 }))
    renderPanel()

    await waitFor(() =>
      expect(screen.getByText(/has not checked in recently/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/classg-autodeploy.timer/)).toBeInTheDocument()
  })

  it('does not warn when the agent checked in recently', async () => {
    deployment.mockResolvedValue(status({ state_age_s: 120 }))
    renderPanel()

    await waitFor(() => expect(screen.getByText(/Running/)).toBeInTheDocument())
    expect(screen.queryByText(/has not checked in recently/)).not.toBeInTheDocument()
  })

  it('distinguishes CI green, failed, running and not checked', async () => {
    const cases: [DeploymentStatus['remote_ci'], RegExp][] = [
      ['success', /CI green/],
      ['failure', /CI failed/],
      ['pending', /CI running/],
      ['unknown', /CI not checked/],
    ]
    for (const [ci, pattern] of cases) {
      deployment.mockResolvedValue(status({ remote_ci: ci, update_available: true }))
      const { unmount } = renderPanel()
      await waitFor(() => expect(screen.getByText(pattern)).toBeInTheDocument())
      unmount()
    }
  })

  // The bug the screenshot caught: Go's omitempty does nothing on a time.Time,
  // so a unit that had never deployed sent "0001-01-01T00:00:00Z" and the panel
  // rendered "Dec 31, 1" beside a "rolled back" badge — a deploy that never
  // happened, reported as a failure.
  it('reports a unit that has never deployed as never, not as year 1', async () => {
    deployment.mockResolvedValue(
      status({ last_deploy_at: '0001-01-01T00:00:00Z', last_deploy_ok: false }),
    )
    renderPanel()

    await waitFor(() => expect(screen.getByText('never')).toBeInTheDocument())
    expect(screen.queryByText(/rolled back/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\b1\b.*Dec|Dec.*\b1\b/)).not.toBeInTheDocument()
  })

  it('treats an absent deploy timestamp as never', async () => {
    deployment.mockResolvedValue(status({ last_deploy_at: undefined, last_deploy_ok: false }))
    renderPanel()

    await waitFor(() => expect(screen.getByText('never')).toBeInTheDocument())
    expect(screen.queryByText(/rolled back/)).not.toBeInTheDocument()
  })

  // CI gates a deploy. On a unit already running that commit the badge answers
  // a question nobody asked, and "not checked" beside a demonstrably running
  // commit reads as a warning.
  it('hides the CI badge when there is nothing to deploy', async () => {
    deployment.mockResolvedValue(status({ update_available: false, remote_ci: 'unknown' }))
    renderPanel()

    await waitFor(() => expect(screen.getByText(/Latest on main/)).toBeInTheDocument())
    expect(screen.queryByText(/CI not checked/)).not.toBeInTheDocument()
  })

  it('shows a rolled-back deploy as such rather than as a success', async () => {
    deployment.mockResolvedValue(
      status({ last_deploy_at: new Date().toISOString(), last_deploy_ok: false }),
    )
    renderPanel()

    await waitFor(() => expect(screen.getByText(/rolled back/)).toBeInTheDocument())
  })
})

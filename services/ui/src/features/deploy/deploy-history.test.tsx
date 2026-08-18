import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { DeploymentHistory } from '@/lib/api/types'

type ApiClientModule = typeof ApiClient

import { DeployHistory } from './deploy-history'

const deploymentHistory = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, deploymentHistory } }
})

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <DeployHistory />
    </QueryClientProvider>,
  )
}

function history(overrides: Partial<DeploymentHistory> = {}): DeploymentHistory {
  return { configured: true, runs: [], ...overrides }
}

const RUN = {
  id: '1-aaaaaaaa',
  started_at: new Date(Date.now() - 200_000).toISOString(),
  finished_at: new Date(Date.now() - 90_000).toISOString(),
  duration_s: 110,
  result: 'deployed' as const,
  commit: 'aaaaaaaabbbbbbbb',
  commit_subject: 'Ship the thing',
  previous_commit: 'ccccccccdddddddd',
  log: ['deploying ccccccccc -> aaaaaaaa', 'rebuilding the web tier'],
}

beforeEach(() => {
  deploymentHistory.mockReset()
})

describe('DeployHistory', () => {
  it('lists a run with its commit, result and duration', async () => {
    deploymentHistory.mockResolvedValue(history({ runs: [RUN] }))
    renderHistory()

    expect(await screen.findByText('Ship the thing')).toBeVisible()
    expect(screen.getByText('aaaaaaaa')).toBeVisible()
    expect(screen.getByText('deployed')).toBeVisible()
    expect(screen.getByText(/1m 50s/)).toBeVisible()
  })

  // The whole point of keeping a history: the agent overwrote its single log
  // every ten minutes, so the log of the deploy that broke something was gone
  // before anyone could read it.
  it('opens a run to reveal the log it produced', async () => {
    deploymentHistory.mockResolvedValue(history({ runs: [RUN] }))
    renderHistory()

    const summary = await screen.findByText('Ship the thing')
    await userEvent.click(summary)

    expect(screen.getByText(/rebuilding the web tier/)).toBeVisible()
    expect(screen.getByText(/cccccccc → aaaaaaaa/)).toBeVisible()
  })

  it('shows a failed run with the step that actually failed', async () => {
    deploymentHistory.mockResolvedValue(
      history({
        runs: [
          {
            ...RUN,
            result: 'failed',
            reason: 'docker compose could not build the web tier; rolled back to cccccccc',
          },
        ],
      }),
    )
    renderHistory()

    expect(await screen.findByText('failed')).toBeVisible()
    await userEvent.click(screen.getByText('Ship the thing'))
    expect(screen.getByText(/docker compose could not build/)).toBeVisible()
  })

  // The agent is a shell script on a box that upgrades independently of this
  // bundle. A result string this build has never heard of must render, not throw.
  it('renders a result it does not recognise rather than crashing', async () => {
    deploymentHistory.mockResolvedValue(
      history({
        runs: [{ ...RUN, result: 'quarantined' as unknown as 'deployed' }],
      }),
    )
    renderHistory()

    expect(await screen.findByText('quarantined')).toBeVisible()
  })

  it('separates a unit with no agent from one that has simply not deployed', async () => {
    deploymentHistory.mockResolvedValue(
      history({ configured: false, reason: 'no deploy state directory is configured' }),
    )
    const { unmount } = renderHistory()
    expect(await screen.findByText('No deploy agent on this unit')).toBeVisible()
    unmount()

    deploymentHistory.mockResolvedValue(history({ runs: [] }))
    renderHistory()
    await waitFor(() => expect(screen.getByText('Nothing recorded yet')).toBeVisible())
  })
})

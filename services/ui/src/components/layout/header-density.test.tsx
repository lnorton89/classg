import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { AuthMe, Health, MonitoringState } from '@/lib/api/types'

import { LiveContext } from '@/app/live-context'

import { AppShell } from './app-shell'

type ApiClientModule = typeof ApiClient

const authMe = vi.hoisted(() => vi.fn())
const health = vi.hoisted(() => vi.fn())
const monitoring = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, authMe, health, monitoring } }
})

// Neither belongs to the header, and both want providers main.tsx supplies.
// Stubbing them keeps this test about the one row it is measuring.
vi.mock('@/components/ui/toast', () => ({ Toaster: () => null }))
vi.mock('@/features/monitoring/track-alerts', () => ({ TrackAlerts: () => null }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useRouter: () => ({ history: { back: vi.fn(), push: vi.fn() } }),
  // The real hook takes a selector. Returning the raw state instead hands
  // SettingsButton an object where it expects a pathname string.
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown
  }) => select({ location: { pathname: '/' } }),
  useNavigate: () => vi.fn(),
}))

function renderShell(connection: 'open' | 'closed' = 'open') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <LiveContext value={{ connection, lastFrameAt: Date.now(), reconnectAttempt: 0 }}>
        <AppShell>
          <p>page</p>
        </AppShell>
      </LiveContext>
    </QueryClientProvider>,
  )
}

const signedIn: AuthMe = {
  authenticated: true,
  auth_enabled: true,
  setup_required: false,
  user: {
    user_id: 'u1',
    username: 'operator',
    display_name: 'Operator',
    role: 'operator',
    disabled: false,
    created_at: '2026-08-11T12:00:00Z',
    updated_at: '2026-08-11T12:00:00Z',
  },
}

const healthy: Health = {
  status: 'ok',
  uptime_s: 100,
  version: '0.1.0',
  sensors: [
    {
      sensor_id: 'wifi-0',
      sensor_kind: 'wifi',
      healthy: true,
      last_heartbeat: '2026-08-11T12:00:00Z',
      seconds_since_heartbeat: 1,
      detections_5m: 0,
    },
  ],
}

const recording: MonitoringState = {
  enabled: true,
  since: '2026-08-11T12:00:00Z',
  discarded_while_paused: 0,
}

beforeEach(() => {
  authMe.mockReset().mockResolvedValue(signedIn)
  health.mockReset().mockResolvedValue(healthy)
  monitoring.mockReset().mockResolvedValue(recording)
})

/**
 * The header used to carry nine controls in one row. On a 360px phone the logo
 * was clipped and the status cluster was unreadable, which is the report that
 * caused this rewrite. jsdom has no layout, so this cannot measure pixels --
 * what it can do is pin the COUNT, which is the thing that actually regressed.
 * Every control added back here has to displace one, not sit beside it.
 */
describe('the header stays sparse', () => {
  it('carries no more than five controls at the top level', async () => {
    renderShell()
    const banner = await screen.findByRole('banner')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /system status/i })).toBeInTheDocument()
    })

    const controls = [
      ...banner.querySelectorAll('button'),
      ...banner.querySelectorAll('a'),
    ].filter((el) => el.closest('nav') === null)

    expect(controls.length).toBeLessThanOrEqual(5)
  })

  // The single fact the header exists to carry. It reaches the button face as
  // a word, not as a colour, because a colour is not readable to everyone and
  // is invisible to somebody glancing at a phone in daylight.
  it('says "Paused" on the status button when recording is off', async () => {
    monitoring.mockResolvedValue({ ...recording, enabled: false })
    renderShell()
    await waitFor(() => {
      expect(screen.getByText('Paused')).toBeInTheDocument()
    })
  })

  it('says "Healthy" when nothing is wrong', async () => {
    renderShell()
    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument()
    })
  })

  // A dropped socket means this SCREEN is stale, not that the detector is.
  // The word has to be on the button, because the map keeps drawing whatever
  // it last heard and looks exactly as it does when everything works.
  it('says "Stale" when only the live stream is down', async () => {
    renderShell('closed')
    await waitFor(() => {
      expect(screen.getByText('Stale')).toBeInTheDocument()
    })
  })

  // A degraded sensor has to be legible without opening anything.
  it('names the number of failed sensors on the button', async () => {
    health.mockResolvedValue({
      ...healthy,
      status: 'degraded',
      sensors: [
        ...healthy.sensors,
        {
          sensor_id: 'sdr-0',
          sensor_kind: 'sdr',
          healthy: false,
          last_heartbeat: '2026-08-11T11:00:00Z',
          seconds_since_heartbeat: 3600,
          detections_5m: 0,
          reason: 'device not found',
        },
      ],
    })
    renderShell()
    await waitFor(() => {
      expect(screen.getByText('1 sensor down')).toBeInTheDocument()
    })
  })
})

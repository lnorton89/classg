import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { Health, MonitoringState, SettingsResponse, TracksResponse } from '@/lib/api/types'

import { TimelinePanel } from './timeline-panel'

type ApiClientModule = typeof ApiClient

const tracks = vi.hoisted(() => vi.fn())
const health = vi.hoisted(() => vi.fn())
const monitoring = vi.hoisted(() => vi.fn())
const settings = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, tracks, health, monitoring, settings } }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}))

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <TimelinePanel />
    </QueryClientProvider>,
  )
}

function healthy(sensors = 1): Health {
  return {
    status: 'ok',
    uptime_s: 100,
    version: '0.1.0',
    sensors: Array.from({ length: sensors }, (_unused, i) => ({
      sensor_id: `wifi-${i}`,
      sensor_kind: 'wifi',
      healthy: true,
      last_heartbeat: new Date().toISOString(),
      seconds_since_heartbeat: 1,
      detections_5m: 0,
    })),
    fusion: { configured: true, connected: true },
  } as Health
}

const noTracks: TracksResponse = { tracks: [], total: 0, next_cursor: '' }
const recording: MonitoringState = {
  enabled: true,
  since: new Date().toISOString(),
  discarded_while_paused: 0,
}
const noSettings = { settings: {} } as SettingsResponse

beforeEach(() => {
  tracks.mockReset().mockResolvedValue(noTracks)
  health.mockReset().mockResolvedValue(healthy())
  monitoring.mockReset().mockResolvedValue(recording)
  settings.mockReset().mockResolvedValue(noSettings)
})

/**
 * The rule this file exists for: an empty band has three meanings that look
 * identical, and only one of them is evidence of a quiet sky.
 */
describe('an empty timeline says why it is empty', () => {
  it('calls it a quiet window when every sensor was healthy', async () => {
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText(/Nothing in this window/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/an empty band means an empty sky/i)).toBeInTheDocument()
  })

  it('refuses to call it quiet when nothing was watching', async () => {
    health.mockResolvedValue({ ...healthy(0), status: 'down' })
    renderPanel()
    await waitFor(() => {
      expect(
        screen.getByText(/Nothing recorded, and nothing was watching/i),
      ).toBeInTheDocument()
    })
    expect(screen.queryByText(/an empty band means an empty sky/i)).not.toBeInTheDocument()
  })

  it('says so when recording was paused, whatever the sensors were doing', async () => {
    monitoring.mockResolvedValue({ ...recording, enabled: false, discarded_while_paused: 42 })
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText(/Recording is paused/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/is not a quiet sky/i)).toBeInTheDocument()
  })
})

// A band that stops abruptly at its left edge is the purge job, not a quiet
// period, and only the configured retention says which.
it('names the retention horizon when one is configured', async () => {
  settings.mockResolvedValue({
    settings: { 'retention.tracks': { value: '720h', source: 'default', mutable: true } },
  })
  renderPanel()
  // Rendered as a person would say it, not as the Go duration it is stored
  // as: "720h0m0s" under a sentence about how long history is kept is not a
  // sentence about how long history is kept.
  await waitFor(() => {
    expect(screen.getByText(/30 days/)).toBeInTheDocument()
  })
  expect(screen.getByText(/purged history rather than a quiet sky/i)).toBeInTheDocument()
})

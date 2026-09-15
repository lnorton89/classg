/**
 * The lanes view, carried over from the Timeline page it replaces.
 *
 * The rule this file exists for is unchanged by the move: an empty band has
 * three meanings that look identical, and only one of them is evidence of a
 * quiet sky. What did change is where the flights come from — the Flights list
 * owns them now and hands them down, so these render the component directly
 * with the set and the window a caller would pass.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { Health, MonitoringState, SettingsResponse, Track } from '@/lib/api/types'

import { FlightLanes } from './flight-lanes'

type ApiClientModule = typeof ApiClient

const health = vi.hoisted(() => vi.fn())
const monitoring = vi.hoisted(() => vi.fn())
const settings = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, health, monitoring, settings } }
})

const NOW = Date.parse('2026-09-15T12:00:00Z')
// Not `window`: a module-level binding of that name shadows the global one for
// every line below it, which is the trap `routes/timeline.tsx` already records.
const band = { startMs: NOW - 3_600_000, endMs: NOW }

function flight(id: string, startMs: number, durationMs: number): Track {
  return {
    schema_version: '1.0',
    track_id: id,
    state: 'CLOSED',
    first_seen: new Date(startMs).toISOString(),
    last_seen: new Date(startMs + durationMs).toISOString(),
    detection_count: 12,
    confidence: 0.6,
    identity: { serial: `SERIAL-${id}` },
  }
}

function renderLanes({
  tracks = [] as Track[],
  selectedId = null as string | null,
  onSelect = vi.fn(),
  truncated = false,
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const result = render(
    <QueryClientProvider client={client}>
      <FlightLanes
        tracks={tracks}
        window={band}
        selectedId={selectedId}
        onSelect={onSelect}
        truncated={truncated}
      />
    </QueryClientProvider>,
  )
  return { ...result, onSelect }
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

const recording: MonitoringState = {
  enabled: true,
  since: new Date().toISOString(),
  discarded_while_paused: 0,
}
const noSettings = { settings: {} } as SettingsResponse

beforeEach(() => {
  health.mockReset().mockResolvedValue(healthy())
  monitoring.mockReset().mockResolvedValue(recording)
  settings.mockReset().mockResolvedValue(noSettings)
})

describe('an empty band says why it is empty', () => {
  it('calls it a quiet window when every sensor was healthy', async () => {
    renderLanes()
    await waitFor(() => {
      expect(screen.getByText(/Nothing in this window/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/an empty band means an empty sky/i)).toBeInTheDocument()
  })

  it('refuses to call it quiet when nothing was watching', async () => {
    health.mockResolvedValue({ ...healthy(0), status: 'down' })
    renderLanes()
    await waitFor(() => {
      expect(
        screen.getByText(/Nothing recorded, and nothing was watching/i),
      ).toBeInTheDocument()
    })
    expect(screen.queryByText(/an empty band means an empty sky/i)).not.toBeInTheDocument()
  })

  it('says so when recording was paused, whatever the sensors were doing', async () => {
    monitoring.mockResolvedValue({ ...recording, enabled: false, discarded_while_paused: 42 })
    renderLanes()
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
  renderLanes()
  // Rendered as a person would say it, not as the Go duration it is stored
  // as: "720h0m0s" under a sentence about how long history is kept is not a
  // sentence about how long history is kept.
  await waitFor(() => {
    expect(screen.getByText(/30 days/)).toBeInTheDocument()
  })
  expect(screen.getByText(/purged history rather than a quiet sky/i)).toBeInTheDocument()
})

it('warns when the window holds more flights than one page returns', async () => {
  renderLanes({ tracks: [flight('a', NOW - 600_000, 120_000)], truncated: true })
  await waitFor(() => {
    expect(screen.getByText(/more tracks than one page holds/i)).toBeInTheDocument()
  })
})

/**
 * The link to the list. A bar a few pixels wide on a seven-day band cannot say
 * which flight it is; the row it opens can.
 */
describe('selecting a bar', () => {
  it('reports the flight the bar belongs to', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderLanes({ tracks: [flight('a', NOW - 600_000, 120_000)] })

    await user.click(await screen.findByRole('button', { name: /SERIAL-a/ }))
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('clears the selection when the open flight is picked again', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderLanes({
      tracks: [flight('a', NOW - 600_000, 120_000)],
      selectedId: 'a',
    })

    await user.click(await screen.findByRole('button', { name: /SERIAL-a/ }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})

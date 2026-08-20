/**
 * The panel that exists to say which hardware is missing had no test, and it
 * was already wrong about half the hardware: the watchdog on a two-adapter
 * unit publishes `wifi_tplink_adapter_present`, and nothing between the shell
 * script and this component carried it, so an unplugged TP-Link was invisible
 * here. scripts/check-mirrors.py now compares the JSON the script writes
 * against the Go struct that reads it; this pins the render.
 *
 * The three-state part is the point. A unit that was never fitted with a
 * second adapter must not show a permanently absent one -- that is the same
 * broken-vs-never-fitted confusion `health.Sensor.optional` exists to avoid --
 * so the field is omitted rather than false, and this asserts both directions.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { WatchdogStatus } from '@/lib/api/types'

type ApiClientModule = typeof ApiClient

import { WatchdogPanel } from './watchdog-panel'

const watchdog = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, watchdog } }
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <WatchdogPanel />
    </QueryClientProvider>,
  )
}

function status(overrides: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return {
    configured: true,
    last_check_at: new Date().toISOString(),
    actions_taken: 0,
    api_healthy: true,
    wifi_adapter_present: true,
    sdr_present: true,
    state_age_s: 30,
    log: ['nothing to repair'],
    ...overrides,
  }
}

beforeEach(() => watchdog.mockReset())

describe('WatchdogPanel', () => {
  it('says nothing about a second adapter on a unit that has never had one', async () => {
    watchdog.mockResolvedValue(status())
    renderPanel()

    expect(await screen.findByText('Wi-Fi adapter')).toBeVisible()
    expect(screen.queryByText('Wi-Fi adapter (TP-Link)')).not.toBeInTheDocument()
  })

  it('reports the second adapter missing from the bus on a unit that has one', async () => {
    watchdog.mockResolvedValue(status({ wifi_tplink_adapter_present: false }))
    renderPanel()

    expect(await screen.findByText('Wi-Fi adapter (TP-Link)')).toBeVisible()
    expect(screen.getByText('hardware — restarting software cannot help')).toBeVisible()
  })

  it('reports the second adapter present when it is on the bus', async () => {
    watchdog.mockResolvedValue(status({ wifi_tplink_adapter_present: true }))
    renderPanel()

    expect(await screen.findByText('Wi-Fi adapter (TP-Link)')).toBeVisible()
    // Both adapters healthy: two "on the bus" badges plus the SDR's.
    expect(screen.getAllByText('on the bus')).toHaveLength(3)
  })

  // The one thing here that is not self-correcting, so it leads the panel.
  it('leads with what the watchdog has stopped trying to repair', async () => {
    watchdog.mockResolvedValue(
      status({ needs_hands: 'classg-sensor-wifi-tplink.service', actions_taken: 3 }),
    )
    renderPanel()

    expect(await screen.findByText('The watchdog has stopped trying')).toBeVisible()
    expect(screen.getByText('classg-sensor-wifi-tplink.service')).toBeVisible()
    expect(screen.getByText('needs attention')).toBeVisible()
  })

  // Nothing else on the box notices when the thing that notices has stopped.
  it('warns when the watchdog itself has not run recently', async () => {
    watchdog.mockResolvedValue(status({ state_age_s: 7 * 60 }))
    renderPanel()

    expect(await screen.findByText('The watchdog itself has not run recently')).toBeVisible()
  })
})

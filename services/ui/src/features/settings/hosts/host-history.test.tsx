import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { HostHistory } from './host-history'
import type { TelemetryResponse, TelemetrySample } from '@/lib/api/types'

const START = Date.parse('2026-08-17T14:00:00Z')

function sample(i: number, overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    ts: new Date(START + i * 60_000).toISOString(),
    cpu_temp_c: 44 + (i % 5),
    load1: 0.5,
    mem_available_kb: 3_400_000,
    disk_free_bytes: 92_000_000_000,
    uptime_s: i * 60,
    ...overrides,
  }
}

function response(
  samples: TelemetrySample[],
  overrides: Partial<TelemetryResponse> = {},
): TelemetryResponse {
  return {
    samples,
    since: new Date(START).toISOString(),
    until: new Date(START + 6 * 3600 * 1000).toISOString(),
    truncated: false,
    ...overrides,
  }
}

function renderHistory(data: TelemetryResponse | undefined, extra: { isError?: boolean } = {}) {
  return render(
    <HostHistory
      data={data}
      isPending={data === undefined && !extra.isError}
      isRefreshing={false}
      isError={extra.isError ?? false}
      window="6h"
      onWindowChange={vi.fn()}
    />,
  )
}

/** The CPU temperature chart, found by the row's accessible name. */
function cpuChart(): HTMLElement {
  const chart = screen
    .getAllByRole('img')
    .find((el) => el.getAttribute('aria-label')?.startsWith('CPU temperature'))
  if (!chart) throw new Error('CPU temperature chart not rendered')
  return chart
}

describe('HostHistory', () => {
  // THE critical rule, pinned at the rendering layer: a null reading breaks
  // the path. One line across the hole — or a vertex at zero — would be
  // fabricated data drawn in the same ink as measurements.
  it('draws a gap at a null reading: two path segments, no ink for the hole', () => {
    const samples = [
      sample(0),
      sample(1),
      sample(2, { cpu_temp_c: null }),
      sample(3, { cpu_temp_c: null }),
      sample(4),
      sample(5),
    ]
    renderHistory(response(samples))

    const chart = cpuChart()
    const segments = chart.querySelectorAll('[data-testid="series-segment"]')
    expect(segments).toHaveLength(2)

    // No path vertex at the y-coordinate a zero would occupy. All real values
    // sit in 44-48, so the padded scale keeps every drawn y well above the
    // strip's bottom edge; a fabricated 0 would fall outside [vMin, vMax] and
    // is simply never drawn.
    const nullTimestamps = new Set(
      [samples[2], samples[3]]
        .filter((s): s is TelemetrySample => s !== undefined)
        .map((s) => Date.parse(s.ts)),
    )
    expect(nullTimestamps.size).toBe(2)
    // The two segments each carry the points of their own run only: first run
    // ends at minute 1, second starts at minute 4 — 2 and 2 vertices.
    const vertexCounts = Array.from(segments).map(
      (path) => (path.getAttribute('d')?.match(/[ML] /g) ?? []).length,
    )
    expect(vertexCounts).toEqual([2, 2])
  })

  it('announces how many readings are unavailable and that they are gaps', () => {
    renderHistory(response([sample(0), sample(1, { cpu_temp_c: null }), sample(2)]))

    expect(cpuChart().getAttribute('aria-label')).toContain(
      '1 of 3 readings unavailable, drawn as gaps',
    )
  })

  it('keeps a lone reading between gaps visible as a point', () => {
    renderHistory(
      response([
        sample(0, { cpu_temp_c: null }),
        sample(1, { cpu_temp_c: 46 }),
        sample(2, { cpu_temp_c: null }),
      ]),
    )

    const chart = cpuChart()
    expect(chart.querySelectorAll('[data-testid="series-segment"]')).toHaveLength(0)
    expect(chart.querySelectorAll('[data-testid="series-point"]')).toHaveLength(1)
  })

  it('says a metric was unavailable for the whole window instead of drawing an empty strip', () => {
    renderHistory(response([sample(0, { cpu_temp_c: null }), sample(1, { cpu_temp_c: null })]))

    expect(screen.getByText('Unavailable for this window')).toBeInTheDocument()
    // The other three metrics still chart normally.
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('shows nulls as "Unavailable" in the table view, never as zero or a dash', async () => {
    renderHistory(response([sample(0), sample(1, { cpu_temp_c: null }), sample(2)]))

    const details = screen.getByText('Show history as a table').closest('details')
    if (!details) throw new Error('table view not rendered')
    // happy-dom does not toggle <details> on summary click; open it directly.
    details.open = true
    details.dispatchEvent(new Event('toggle'))

    expect(await screen.findByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText('0.0 °C')).not.toBeInTheDocument()
  })

  // A chart whose axis claims 6 h while showing less is a lie: when the
  // response is truncated the axis must stop at the last returned sample and
  // the panel must say why.
  it('surfaces truncation and ends the axis at the last returned sample', () => {
    const samples = [sample(0), sample(1), sample(2)]
    renderHistory(
      response(samples, {
        truncated: true,
        until: new Date(START + 6 * 3600 * 1000).toISOString(),
      }),
    )

    expect(screen.getByText(/holds more history than the api returns/)).toBeInTheDocument()
    // Axis end label is the last sample's clock time (14:02 UTC), not 20:00.
    expect(screen.getAllByText('14:02:00').length).toBeGreaterThan(0)
    expect(screen.queryByText('20:00:00')).not.toBeInTheDocument()
  })

  it('claims the full requested window on the axis when nothing was truncated', () => {
    renderHistory(response([sample(0), sample(1)]))

    expect(screen.getByText('14:00:00')).toBeInTheDocument()
    expect(screen.getByText('20:00:00')).toBeInTheDocument()
  })

  it('says so when there is no history yet', () => {
    renderHistory(response([]))
    expect(screen.getByText(/No history recorded in this window yet/)).toBeInTheDocument()
  })

  it('reports a failed /telemetry read without touching the live readings', () => {
    renderHistory(undefined, { isError: true })
    expect(screen.getByText(/History is unavailable/)).toBeInTheDocument()
  })
})

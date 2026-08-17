import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SpectrumSweepDetail } from '@/lib/api/types'

import { SpectrumChart } from './spectrum-chart'

/**
 * The pointer surface, with a real width.
 *
 * jsdom reports every element as zero-size, and the chart's move handler bails
 * on a zero-width rect -- correctly, since dividing by it would put every hover
 * at the same frequency. Stubbing the rect is what makes the handler reachable
 * at all rather than the test silently exercising the early return.
 */
function hoverSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector<HTMLElement>('.cursor-crosshair')
  if (!surface) throw new Error('no hover surface rendered')
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 260, right: 1000, bottom: 260, x: 0, y: 0 }) as DOMRect
  return surface
}

/** Move the pointer to a 0..1 position across the plot. */
function hoverAt(surface: HTMLElement, fraction: number) {
  fireEvent.pointerMove(surface, { clientX: fraction * 1000, clientY: 100 })
}

function sweep(
  dbfs: (number | null)[],
  overrides: Partial<SpectrumSweepDetail> = {},
): SpectrumSweepDetail {
  return {
    sweep_id: '01J8',
    band: 'ism_915',
    state: 'completed',
    started_at: '2026-08-17T14:00:00Z',
    noise_floor_dbfs: -70.5,
    threshold_dbfs: -60.5,
    trace: {
      start_hz: 902_000_000,
      stop_hz: 902_000_000 + dbfs.length * 10_000,
      bin_width_hz: 10_000,
      dbfs,
      blind: dbfs.filter((v) => v === null).length,
    },
    ...overrides,
  }
}

describe('SpectrumChart', () => {
  it('breaks the path at an unmeasured cell instead of drawing one line', () => {
    // The rule this whole feature exists to keep: a DC guard must not become a
    // level. One continuous path across the null would show a signal strength
    // at a frequency the receiver is blind to.
    const { container } = render(<SpectrumChart sweep={sweep([-70, -71, null, -69, -68])} />)

    expect(container.querySelectorAll('[data-testid="trace-segment"]')).toHaveLength(2)
  })

  it('draws one path when nothing is missing', () => {
    const { container } = render(<SpectrumChart sweep={sweep([-70, -71, -72, -69])} />)

    expect(container.querySelectorAll('[data-testid="trace-segment"]')).toHaveLength(1)
  })

  it('gives a lone reading between two gaps its own ink', () => {
    const { container } = render(<SpectrumChart sweep={sweep([null, -55, null])} />)

    expect(container.querySelectorAll('[data-testid="trace-point"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="trace-segment"]')).toHaveLength(0)
  })

  it('says how much of the band is a gap and why', () => {
    render(<SpectrumChart sweep={sweep([-70, null, null, -69])} />)

    expect(screen.getByText(/50.0% of the band is a gap/)).toBeInTheDocument()
    expect(screen.getByText(/oscillator lands at every step centre/)).toBeInTheDocument()
  })

  it('does not mention gaps when the band was fully measured', () => {
    render(<SpectrumChart sweep={sweep([-70, -71, -72])} />)

    expect(screen.queryByText(/of the band is a gap/)).not.toBeInTheDocument()
  })

  it('never claims a signal is a drone', () => {
    // A peak well above the threshold is the case where a UI would be most
    // tempted to say something. It must not: energy is not identity, and the
    // detector that could tell these apart is not in this build.
    render(<SpectrumChart sweep={sweep([-70, -30, -70], { peak_dbfs: -30, peak_hz: 902_015_000 })} />)

    expect(screen.getByText(/energy, not identity/i)).toBeInTheDocument()
    expect(screen.queryByText(/drone detected/i)).not.toBeInTheDocument()
    expect(screen.getByText(/no line on this chart is a drone/i)).toBeInTheDocument()
  })

  it('says nothing cleared the threshold when nothing did', () => {
    render(<SpectrumChart sweep={sweep([-80, -79, -81], { peak_dbfs: -79 })} />)

    expect(screen.getByText(/Nothing here cleared the threshold/)).toBeInTheDocument()
  })

  it('reports a hovered notch as unmeasured rather than the nearest reading', () => {
    // Snapping to a neighbour would label a measurement with a frequency it was
    // not taken at, which is a fabricated detection at a made-up frequency.
    const { container } = render(<SpectrumChart sweep={sweep([-70, null, -45])} />)
    const surface = hoverSurface(container)

    // Middle of the plot: the null cell.
    hoverAt(surface, 0.5)

    // Scoped to the readout: the frequency axis carries MHz labels too.
    const readout = within(screen.getByTestId('chart-readout'))
    expect(readout.getByText(/Unmeasured — the receiver is blind here/)).toBeInTheDocument()
    expect(screen.getByTestId('chart-readout')).toHaveTextContent('902.015 MHz')
    // The neighbouring readings must not be borrowed to fill the hole.
    expect(screen.getByTestId('chart-readout')).not.toHaveTextContent('-45.0 dBFS')
  })

  it('reads out the measured level when the pointer is on a measured cell', () => {
    const { container } = render(<SpectrumChart sweep={sweep([-70, null, -45])} />)
    const surface = hoverSurface(container)

    hoverAt(surface, 0.9)

    expect(screen.getByTestId('chart-readout')).toHaveTextContent('-45.0 dBFS')
  })

  it('describes itself for a screen reader without claiming an identification', () => {
    render(<SpectrumChart sweep={sweep([-70, null, -45])} />)

    const label = screen.getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/unmeasured and drawn as gaps/)
    expect(label).toMatch(/Energy only; no signal is identified/)
  })

  it('warns when steps read short, because the axis then overstates coverage', () => {
    render(<SpectrumChart sweep={sweep([-70, -71], { short_reads: 3 })} />)

    expect(screen.getByText(/3 steps read too short/)).toBeInTheDocument()
  })

  it('renders a message rather than an empty plot when there is no measurement', () => {
    render(<SpectrumChart sweep={sweep([], { trace: undefined })} />)

    expect(screen.getByText(/no measurement to draw/i)).toBeInTheDocument()
  })

  it('survives a sweep whose floor and threshold were never measured', () => {
    // A failed-then-partially-recorded sweep. Nothing here may divide by zero
    // or render NaN into a path, which draws nothing and looks like a quiet band.
    const { container } = render(
      <SpectrumChart
        sweep={sweep([-70, -70, -70], { noise_floor_dbfs: null, threshold_dbfs: null })}
      />,
    )

    const paths = container.querySelectorAll('[data-testid="trace-segment"]')
    expect(paths).toHaveLength(1)
    expect(paths[0]?.getAttribute('d')).not.toMatch(/NaN/)
  })
})

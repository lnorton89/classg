/**
 * The two things this component exists for, and one thing it must not do.
 *
 * It exists to group a long key-value run under a heading, and to render a
 * distribution as bars. It must not announce the bar: the bar is drawn against
 * the group's own peak rather than against 100%, so a screen reader that read
 * it as a meter would give a second, differently-scaled number for a value the
 * row has already stated.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { EMPTY } from '@/lib/format'

import { KeyValueGroup } from './key-value-group'

function widths(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[role="img"] > span')].map(
    (fill) => fill.style.width,
  )
}

describe('KeyValueGroup', () => {
  it('renders a heading over its rows', () => {
    render(
      <KeyValueGroup
        title="Dwell share by channel"
        entries={[{ id: '6', label: 'ch 6', value: '57.6%' }]}
      />,
    )
    expect(screen.getByText('Dwell share by channel')).toBeVisible()
    expect(screen.getByText('ch 6')).toBeVisible()
    expect(screen.getByText('57.6%')).toBeVisible()
  })

  it('scales bars against the group peak, not against 1', () => {
    // The failure this prevents: a per-channel count of 8.1 million against a
    // 0-1 axis is one full bar beside five invisible ones, which says less
    // than the numbers did.
    const { container } = render(
      <KeyValueGroup
        entries={[
          { id: 'a', label: 'ch 1', value: '2,000', fraction: 2000 },
          { id: 'b', label: 'ch 6', value: '8,000', fraction: 8000 },
          { id: 'c', label: 'ch 11', value: '4,000', fraction: 4000 },
        ]}
      />,
    )
    expect(widths(container)).toEqual(['25%', '100%', '50%'])
  })

  it('draws no bar at all for rows that did not ask for one', () => {
    const { container } = render(
      <KeyValueGroup entries={[{ id: 'a', label: 'Interface', value: 'wlan1' }]} />,
    )
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(0)
  })

  it('survives a group whose every value is zero', () => {
    // Peak zero would otherwise divide by zero and render `NaN%`.
    const { container } = render(
      <KeyValueGroup
        entries={[
          { id: 'a', label: 'ch 1', value: '0', fraction: 0 },
          { id: 'b', label: 'ch 6', value: '0', fraction: 0 },
        ]}
      />,
    )
    expect(widths(container)).toEqual(['0%', '0%'])
  })

  it('hides the bars from assistive technology', () => {
    const { container } = render(
      <KeyValueGroup entries={[{ id: 'a', label: 'ch 1', value: '50%', fraction: 0.5 }]} />,
    )
    expect(container.querySelector('[role="img"]')?.closest('[aria-hidden]')).not.toBeNull()
  })

  it('announces a missing reading as "not reported" rather than as an em dash', () => {
    render(<KeyValueGroup entries={[{ id: 'a', label: 'Channel', value: EMPTY }]} />)
    expect(screen.getByText('not reported')).toBeInTheDocument()
  })

  it('carries the density hooks the compact preference acts on', () => {
    const { container } = render(
      <KeyValueGroup
        title="Radio"
        entries={[{ id: 'a', label: 'Interface', value: 'wlan1' }]}
      />,
    )
    // styles.css tightens `[data-density-row]` and the seam between
    // `[data-density-group]`s; without the attributes the preference is a
    // setting that changes nothing, which is what it was.
    expect(container.querySelector('[data-density-group]')).not.toBeNull()
    expect(container.querySelector('[data-density-row]')).not.toBeNull()
  })
})

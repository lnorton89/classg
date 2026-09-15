import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MetricStrip } from './metric-strip'

describe('MetricStrip', () => {
  it('renders one tile per metric', () => {
    render(
      <MetricStrip
        label="Flight summary"
        metrics={[
          { id: 'duration', label: 'Duration', value: '4m 12s' },
          { id: 'range', label: 'Max range', value: '1.2 km' },
        ]}
      />,
    )
    expect(screen.getByText('Duration')).toBeVisible()
    expect(screen.getByText('4m 12s')).toBeVisible()
    expect(screen.getByText('Max range')).toBeVisible()
  })

  it('renders nothing rather than an empty grid', () => {
    // An empty strip under a heading claims the page measured six things and
    // got nothing; no strip at all says the sensor has not reported yet.
    const { container } = render(<MetricStrip metrics={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the group, so a tile is not read as a loose number', () => {
    render(
      <MetricStrip
        label="wifi-0 summary"
        metrics={[{ id: 'a', label: 'Heard', value: '8.1M' }]}
      />,
    )
    expect(screen.getByRole('group', { name: 'wifi-0 summary' })).toBeInTheDocument()
  })

  it.each([3, 4, 6] as const)('emits a literal class for %i columns', (columns) => {
    const { container } = render(
      <MetricStrip columns={columns} metrics={[{ id: 'a', label: 'Heard', value: '1' }]} />,
    )
    const grid = container.querySelector('[data-density-strip]')
    // Tailwind generates nothing for a name assembled at runtime, so an
    // interpolated column count is a grid that silently has one column.
    expect(grid?.className).toContain('grid-cols-2')
    expect(grid?.className).not.toContain('${')
  })

  it('carries the density hook the compact preference acts on', () => {
    const { container } = render(
      <MetricStrip metrics={[{ id: 'a', label: 'Heard', value: '1' }]} />,
    )
    expect(container.querySelector('[data-density-strip]')).not.toBeNull()
  })
})

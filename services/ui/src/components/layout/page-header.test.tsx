import { render, screen } from '@testing-library/react'
import { RadarIcon } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { PageHeader, SectionHeader } from './page-header'

describe('PageHeader', () => {
  it('gives the page exactly one h1', () => {
    render(<PageHeader icon={RadarIcon} title="Sensors" description="One at a time." />)
    expect(screen.getByRole('heading', { level: 1, name: 'Sensors' })).toBeVisible()
    expect(screen.getAllByRole('heading')).toHaveLength(1)
  })

  it('places the eyebrow above the title, not inside it', () => {
    // A breadcrumb is about where the page sits, not about what it contains,
    // so it must not end up in the heading's accessible name.
    render(
      <PageHeader
        icon={RadarIcon}
        title="wifi-0-capture.pcap"
        eyebrow={<a href="/sensors">Sensors and captures</a>}
      />,
    )
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveAccessibleName('wifi-0-capture.pcap')
    expect(screen.getByRole('link', { name: 'Sensors and captures' })).toBeVisible()
    expect(heading.contains(screen.getByRole('link'))).toBe(false)
  })

  it('omits the eyebrow row entirely when there is none', () => {
    const { container } = render(<PageHeader icon={RadarIcon} title="Sensors" />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('keeps actions out of the heading', () => {
    render(
      <PageHeader
        icon={RadarIcon}
        title="Settings"
        actions={<button type="button">Reset</button>}
      />,
    )
    expect(screen.getByRole('button', { name: 'Reset' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Settings')
  })

  it('renders the description only when given one', () => {
    const { rerender } = render(<PageHeader icon={RadarIcon} title="Logs" />)
    expect(screen.queryByText('Everything observed.')).not.toBeInTheDocument()
    rerender(<PageHeader icon={RadarIcon} title="Logs" description="Everything observed." />)
    expect(screen.getByText('Everything observed.')).toBeVisible()
  })
})

describe('SectionHeader', () => {
  it('sits one level down, so a page is not a list of h1s', () => {
    render(<SectionHeader icon={RadarIcon} title="Active tracks" id="active" />)
    const heading = screen.getByRole('heading', { level: 2, name: 'Active tracks' })
    expect(heading).toHaveAttribute('id', 'active')
  })
})

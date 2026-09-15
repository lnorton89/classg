/**
 * What is worth pinning about a pill is not that it renders — it is that the
 * five tones stay five, that a tone reaches the DOM as a class rather than as
 * an interpolated string Tailwind would never generate, and that the header's
 * `<button>` and a row's `<span>` are drawing from the same palette. All three
 * are the failures that produced the vocabulary drift this component replaced.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatusPill } from './status-pill'
import { statusPill, STATUS_DOT, type StatusPillTone } from './status-pill-variants'

const TONES: StatusPillTone[] = ['ok', 'warn', 'down', 'info', 'muted']

describe('StatusPill', () => {
  it('renders its label', () => {
    render(<StatusPill tone="ok">healthy</StatusPill>)
    expect(screen.getByText('healthy')).toBeVisible()
  })

  it.each(TONES)('gives %s its own colour classes', (tone) => {
    const classes = statusPill({ tone })
    // Literal class names, never `text-${tone}`: Tailwind scans source text
    // and generates no CSS for a name that only exists once a template has
    // been evaluated, so an interpolated tone renders as unstyled text.
    expect(classes).toMatch(
      /\b(text-ok|text-warn|text-down|text-primary|text-muted-foreground)\b/,
    )
    expect(classes).not.toContain('${')
  })

  it('gives every tone a distinct class string', () => {
    const rendered = TONES.map((tone) => statusPill({ tone }))
    expect(new Set(rendered).size).toBe(TONES.length)
  })

  it('exposes a dot colour for every tone, so the header cannot drift', () => {
    // The header draws its dot outside the component; if a tone were added
    // here without a dot, that button would render a colourless one.
    expect(Object.keys(STATUS_DOT).sort()).toEqual([...TONES].sort())
  })

  it('draws no dot unless asked', () => {
    const { container } = render(<StatusPill tone="down">down</StatusPill>)
    expect(container.querySelectorAll('span[aria-hidden]')).toHaveLength(0)
  })

  it('draws the dot in the pill colour rather than its own', () => {
    const { container } = render(
      <StatusPill tone="ok" dot>
        healthy
      </StatusPill>,
    )
    const dot = container.querySelector('span[aria-hidden]')
    expect(dot?.className).toContain('bg-current')
  })

  it('pulses only when told to, because a permanent pulse is an unread alarm', () => {
    const { container, rerender } = render(
      <StatusPill tone="ok" dot>
        healthy
      </StatusPill>,
    )
    expect(container.querySelector('span[aria-hidden]')?.className).not.toContain(
      'animate-pulse',
    )

    rerender(
      <StatusPill tone="warn" dot pulse>
        repairing
      </StatusPill>,
    )
    expect(container.querySelector('span[aria-hidden]')?.className).toContain('animate-pulse')
  })

  it('keeps the md size geometrically identical to the Badge it replaced', () => {
    // The migration changed the vocabulary, not the layout of any row a pill
    // sits in. Badge is `rounded-md px-1.5 py-0.5 text-xs`.
    const md = statusPill({ size: 'md' })
    expect(md).toContain('rounded-md')
    expect(md).toContain('px-1.5')
    expect(md).toContain('py-0.5')
    expect(md).toContain('text-xs')
  })

  it('passes through the ARIA a live status needs', () => {
    render(
      <StatusPill tone="ok" role="status" aria-live="polite">
        Recording
      </StatusPill>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Recording')
  })
})

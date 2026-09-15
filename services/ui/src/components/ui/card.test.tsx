/**
 * The rule the weights exist to make possible — at most one primary card per
 * page — is a review-time rule, not something a component can enforce. What
 * this pins is the half that can regress silently: that omitting `weight`
 * still draws exactly today's card, so a page that has not been through the
 * hierarchy pass is unchanged rather than quietly demoted.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Card, CardContent } from './card'

function classesOf(html: HTMLElement): string {
  return html.querySelector('div')?.className ?? ''
}

describe('Card weights', () => {
  it('draws the current card when no weight is given', () => {
    const { container } = render(<Card>body</Card>)
    const plain = classesOf(container)
    const { container: explicit } = render(<Card weight="secondary">body</Card>)
    expect(plain).toBe(classesOf(explicit))
  })

  it('lifts a primary card off the ground', () => {
    const { container } = render(<Card weight="primary">body</Card>)
    expect(classesOf(container)).toContain('shadow-md')
    expect(classesOf(container)).toContain('border-primary/25')
  })

  it('gives a plain card neither border nor ground', () => {
    const { container } = render(<Card weight="plain">body</Card>)
    expect(classesOf(container)).toContain('border-0')
    expect(classesOf(container)).toContain('bg-transparent')
    expect(classesOf(container)).toContain('shadow-none')
  })

  it('un-insets a plain card’s sections, so it does not read as a card someone forgot to draw', () => {
    const { container } = render(
      <Card weight="plain">
        <CardContent>body</CardContent>
      </Card>,
    )
    expect(classesOf(container)).toContain('[&>[data-card-section]]:px-0')
    expect(container.querySelector('[data-card-section]')).not.toBeNull()
  })

  it('records the weight on the element, so a page can be audited for two primaries', () => {
    const { container } = render(<Card weight="primary">body</Card>)
    expect(container.querySelector('[data-card-weight="primary"]')).not.toBeNull()
  })
})

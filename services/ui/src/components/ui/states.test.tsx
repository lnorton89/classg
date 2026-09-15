/**
 * Empty, error, and "why" — the three things a panel shows when it is not
 * showing content.
 *
 * The one that matters on this product is the distinction between the first
 * two. "No detections in this window" and "could not ask for the detections"
 * were being drawn identically, as a dimmed line of text, and that is the
 * confusion the whole interface is built to refuse: an absence of readings is
 * evidence of a quiet sky only if the reading was actually taken.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { EmptyState, ErrorState } from './misc'
import { Why } from './why'

describe('EmptyState and ErrorState are told apart', () => {
  it('announces an error and not an empty result', () => {
    render(<ErrorState title="History is unavailable">The api did not answer.</ErrorState>)
    expect(screen.getByRole('alert')).toHaveTextContent('History is unavailable')
  })

  it('leaves an empty result silent, because nothing has gone wrong', () => {
    render(<EmptyState title="No captures yet" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('No captures yet')).toBeVisible()
  })

  it('carries a reason, which is the whole point of the error case', () => {
    render(
      <ErrorState title="History is unavailable">
        The api did not answer /telemetry.
      </ErrorState>,
    )
    expect(screen.getByText(/did not answer/)).toBeVisible()
  })

  it('can offer a way out', () => {
    render(
      <ErrorState
        title="Could not read the receiver"
        action={<button type="button">Retry</button>}
      >
        Timed out.
      </ErrorState>,
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })
})

describe('Why', () => {
  it('starts closed, so the explanation costs no vertical space', () => {
    const { container } = render(<Why>Because the counters are cumulative.</Why>)
    expect(container.querySelector('details')?.open).toBe(false)
  })

  it('opens on click and shows the rationale', async () => {
    const user = userEvent.setup()
    const { container } = render(<Why>Because the counters are cumulative.</Why>)

    await user.click(screen.getByText('Why?'))
    expect(container.querySelector('details')?.open).toBe(true)
    expect(screen.getByText(/counters are cumulative/)).toBeVisible()
  })

  it('takes a more specific question than "Why?"', () => {
    render(<Why label="What does zero detections mean?">A quiet sky.</Why>)
    expect(screen.getByText('What does zero detections mean?')).toBeVisible()
  })

  it('keeps the rationale in the DOM while closed, so find-in-page still reaches it', () => {
    // `<details>` rather than a popover precisely for this: a browser expands
    // a closed disclosure when its text matches a page search.
    render(<Why>Because the counters are cumulative.</Why>)
    expect(screen.getByText(/counters are cumulative/)).toBeInTheDocument()
  })
})

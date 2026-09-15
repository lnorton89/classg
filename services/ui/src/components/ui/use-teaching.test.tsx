/**
 * A one-time explainer, and the promise that it is one-time.
 *
 * The thing that has to hold across a reload: dismissing the track state key
 * once means not seeing it again. The thing that has to hold the other way:
 * the "?" brings it back for good, not for one render.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TeachingBanner, TeachingHelpButton } from './teaching-banner'
import { useTeaching } from './use-teaching'

function Subject({ id = 'test-band' }: { id?: string }) {
  const teaching = useTeaching(id)
  return (
    <>
      <TeachingHelpButton teaching={teaching} title="the test band" />
      <TeachingBanner teaching={teaching} title="the test band" titleId="test-band-title">
        <h2 id="test-band-title">What this means</h2>
      </TeachingBanner>
    </>
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('a one-time teaching banner', () => {
  it('shows on a first visit, with no "?" competing with it', () => {
    render(<Subject />)
    expect(screen.getByText('What this means')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Show the test band/ })).not.toBeInTheDocument()
  })

  it('dismisses, and stays dismissed for the next visit', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Subject />)
    await user.click(screen.getByRole('button', { name: /Dismiss the test band/ }))
    expect(screen.queryByText('What this means')).not.toBeInTheDocument()

    // Namespaced with every other key this app writes.
    expect(window.localStorage.getItem('classg.taught.test-band')).toBe('1')

    unmount()
    render(<Subject />)
    expect(screen.queryByText('What this means')).not.toBeInTheDocument()
  })

  it('offers the "?" only once the band is gone, and brings it back for good', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Subject />)
    await user.click(screen.getByRole('button', { name: /Dismiss the test band/ }))
    await user.click(screen.getByRole('button', { name: /Show the test band/ }))

    expect(screen.getByText('What this means')).toBeVisible()
    // Restoring clears the stored dismissal: a band that vanished again on the
    // next navigation would read as a bug rather than as a setting.
    expect(window.localStorage.getItem('classg.taught.test-band')).toBeNull()

    unmount()
    render(<Subject />)
    expect(screen.getByText('What this means')).toBeVisible()
  })

  it('keeps two bands independent', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Subject id="band-a" />
        <Subject id="band-b" />
      </>,
    )
    const [first] = screen.getAllByRole('button', { name: /Dismiss the test band/ })
    if (!first) throw new Error('expected two dismissible bands')
    await user.click(first)
    expect(screen.getAllByText('What this means')).toHaveLength(1)
  })

  it('still renders when storage throws, as it does in a private window', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    // Showing the explainer again is a far smaller problem than a page that
    // will not render.
    expect(() => render(<Subject />)).not.toThrow()
    expect(screen.getByText('What this means')).toBeVisible()
    getItem.mockRestore()
  })
})

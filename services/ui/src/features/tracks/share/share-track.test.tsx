/**
 * The browser preview in this environment cannot register the MSW service
 * worker, so the redesign here (inline panel -> modal dialog) was checked by
 * hand-reading Base UI's Dialog behaviour rather than in a live browser. This
 * pins the part that matters most: the dialog actually opens as a modal with
 * its content, and closes the ways a modal is expected to close.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { trackMini5Pro } from '@/mocks/fixtures/tracks'
import { ToastProvider } from '@/components/ui/toast-primitives'

import { ShareTrack } from './share-track'

function renderShareTrack() {
  return render(
    <ToastProvider>
      <ShareTrack track={trackMini5Pro} />
    </ToastProvider>,
  )
}

describe('ShareTrack', () => {
  it('opens the share card as a modal dialog, not an inline panel', async () => {
    const user = userEvent.setup()
    renderShareTrack()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Share' }))

    const dialog = await screen.findByRole('dialog', { name: 'Share this detection' })
    expect(within(dialog).getByRole('img', { name: /ClassG detection record/ })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /Download PNG/ })).toBeVisible()
    // Off by default: precision is opt-in -- the card's own caption calls exact
    // coordinates for a grounded aircraft "effectively an address".
    expect(
      within(dialog).getByRole('switch', { name: 'Include exact location' }),
    ).not.toBeChecked()
  })

  it('closes on its own close button, not the trigger', async () => {
    const user = userEvent.setup()
    renderShareTrack()

    await user.click(screen.getByRole('button', { name: 'Share' }))
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The trigger is unchanged by opening/closing -- it never became a
    // second close button the way the old inline-panel toggle did.
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderShareTrack()

    await user.click(screen.getByRole('button', { name: 'Share' }))
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('disables the location toggle for a track with no reported position', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ShareTrack track={{ ...trackMini5Pro, current: undefined }} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Share' }))
    const dialog = await screen.findByRole('dialog')

    // Base UI's switch marks itself with aria-disabled rather than the native
    // disabled attribute, which a plain <span role="switch"> cannot carry.
    expect(
      within(dialog).getByRole('switch', { name: 'Include exact location' }),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(within(dialog).getByText(/This track broadcast no position/)).toBeVisible()
  })
})

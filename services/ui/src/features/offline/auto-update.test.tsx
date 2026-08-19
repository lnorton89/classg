import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStatus } from './app-update'

/**
 * A waiting build must be taken IMMEDIATELY -- no banner, no countdown, no
 * veto, and no hold while a sweep or capture runs.
 *
 * This exists because the opposite behaviour shipped and had to be removed:
 * the console asked permission, counted down in front of the operator, and
 * offered "Keep this one". The trade it was making -- protect the map's pan and
 * zoom -- is the wrong one for a detector, because it leaves somebody reading a
 * stale build in front of a live sky. Sweeps and captures run in the API on the
 * unit, not in this tab, so a reload never costs a measurement.
 *
 * Without this test the only thing stopping that policy coming back is that
 * nobody has written it again: the module that held it was deleted, tests and
 * all.
 */

const applyUpdate = vi.fn()
let listener: ((status: UpdateStatus) => void) | null = null
let status: UpdateStatus = 'idle'

vi.mock('./register-sw', () => ({
  registerAppServiceWorker: () =>
    Promise.resolve({
      getStatus: () => status,
      subscribe: (fn: (s: UpdateStatus) => void) => {
        listener = fn
        return () => {
          listener = null
        }
      },
      applyUpdate,
      // Unused by the hook, present because the watcher interface has them.
      start: vi.fn(),
      stop: vi.fn(),
      checkNow: vi.fn(),
    }),
}))

const { useAppUpdate } = await import('./hooks')
const { AppUpdateBanner } = await import('./offline-banner')

function Probe() {
  const { status: s } = useAppUpdate()
  return <span data-testid="status">{s}</span>
}

describe('a waiting build', () => {
  beforeEach(() => {
    applyUpdate.mockClear()
    listener = null
    status = 'idle'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('is applied without being asked, the moment it is available', async () => {
    render(<Probe />)
    await waitFor(() => expect(listener).not.toBeNull())

    expect(applyUpdate).not.toHaveBeenCalled()

    status = 'available'
    listener?.('available')

    await waitFor(() => expect(applyUpdate).toHaveBeenCalled())
  })

  it('is not applied while nothing is waiting', async () => {
    render(<Probe />)
    await waitFor(() => expect(listener).not.toBeNull())

    listener?.('idle')
    listener?.('applying')

    expect(applyUpdate).not.toHaveBeenCalled()
  })

  it('renders no banner at all -- there is nothing to consent to', async () => {
    const { container } = render(<AppUpdateBanner />)
    await waitFor(() => expect(listener).not.toBeNull())

    status = 'available'
    listener?.('available')

    await waitFor(() => expect(applyUpdate).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SkyState } from './sky-state'
import { SkyStateBanner } from './components'

const QUIET_SKY_DISMISS_MS = 20_000

function quietSky(): SkyState {
  return {
    kind: 'quiet',
    absenceIsEvidence: true,
    title: 'Quiet sky',
    detail: 'All sensors are reporting. An empty map means an empty sky.',
    tone: 'ok',
    unhealthy: [],
    healthy: [],
    trackCount: 0,
  }
}

function sensorDown(): SkyState {
  return {
    kind: 'degraded',
    absenceIsEvidence: false,
    title: 'Coverage degraded',
    detail: 'A sensor is down. An empty map is not evidence of a quiet sky.',
    tone: 'warn',
    unhealthy: [],
    healthy: [],
    trackCount: 0,
  }
}

// The dismiss timeout is scheduled from a plain setTimeout callback rather
// than from a user-event or an effect React is already tracking, so
// `vi.advanceTimersByTimeAsync` alone does not reliably flush the state
// update it causes in this environment (happy-dom) -- wrapping it in `act`
// does.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('SkyStateBanner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers no dismiss control when the absence of tracks is not evidence', () => {
    render(<SkyStateBanner state={sensorDown()} />)
    expect(screen.getByText('Coverage degraded')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Dismiss until the sky state changes' }),
    ).not.toBeInTheDocument()
  })

  it('closes on its own button, after the exit animation finishes', async () => {
    vi.useFakeTimers()
    render(<SkyStateBanner state={quietSky()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss until the sky state changes' }))
    // Still present -- the slide-and-fade plays before it actually leaves.
    expect(screen.getByText('Quiet sky')).toBeInTheDocument()

    await advance(200)
    expect(screen.queryByText('Quiet sky')).not.toBeInTheDocument()
  })

  it('dismisses itself after the quiet-sky timer, not before', async () => {
    vi.useFakeTimers()
    render(<SkyStateBanner state={quietSky()} />)

    // Just short of the 20s trigger.
    await advance(19_900)
    expect(screen.getByText('Quiet sky')).toBeInTheDocument()

    // Past the trigger, but inside the exit animation's 180ms.
    await advance(150)
    expect(screen.getByText('Quiet sky')).toBeInTheDocument()

    // Past the exit animation too.
    await advance(200)
    expect(screen.queryByText('Quiet sky')).not.toBeInTheDocument()
  })

  it('shows an escalation at full visibility after a dismissal', async () => {
    // Regression: closing/drag state used to live in the keyed HOST element,
    // which a key change remounts without resetting hook state -- so after
    // "Quiet sky" auto-dismissed, "Coverage degraded" rendered permanently
    // slid off screen at opacity 0.
    vi.useFakeTimers()
    const { rerender } = render(<SkyStateBanner state={quietSky()} />)

    await advance(QUIET_SKY_DISMISS_MS + 500)
    expect(screen.queryByText('Quiet sky')).not.toBeInTheDocument()

    rerender(<SkyStateBanner state={sensorDown()} />)
    const banner = screen.getByRole('alert')
    expect(screen.getByText('Coverage degraded')).toBeVisible()
    // Not carrying the previous banner's exit animation styles.
    expect(banner.style.transform).toBe('')
    expect(banner.style.opacity).toBe('')
  })

  it('never auto-dismisses a state where the absence of tracks is not evidence', async () => {
    vi.useFakeTimers()
    render(<SkyStateBanner state={sensorDown()} />)

    await advance(60_000)
    expect(screen.getByText('Coverage degraded')).toBeInTheDocument()
  })

  describe('swipe', () => {
    it('dismisses on a swipe past the threshold', async () => {
      vi.useFakeTimers()
      render(<SkyStateBanner state={quietSky()} />)
      const banner = screen.getByRole('status')

      fireEvent.pointerDown(banner, { clientX: 0, pointerId: 1 })
      fireEvent.pointerMove(banner, { clientX: -150, pointerId: 1 })
      fireEvent.pointerUp(banner, { clientX: -150, pointerId: 1 })

      await advance(200)
      expect(screen.queryByText('Quiet sky')).not.toBeInTheDocument()
    })

    it('snaps back and stays open on a short swipe', async () => {
      vi.useFakeTimers()
      render(<SkyStateBanner state={quietSky()} />)
      const banner = screen.getByRole('status')

      fireEvent.pointerDown(banner, { clientX: 0, pointerId: 1 })
      fireEvent.pointerMove(banner, { clientX: -30, pointerId: 1 })
      fireEvent.pointerUp(banner, { clientX: -30, pointerId: 1 })

      await advance(500)
      expect(screen.getByText('Quiet sky')).toBeInTheDocument()
    })

    it('cannot be swiped away when the absence of tracks is not evidence', async () => {
      vi.useFakeTimers()
      render(<SkyStateBanner state={sensorDown()} />)
      const banner = screen.getByRole('alert')

      fireEvent.pointerDown(banner, { clientX: 0, pointerId: 1 })
      fireEvent.pointerMove(banner, { clientX: -200, pointerId: 1 })
      fireEvent.pointerUp(banner, { clientX: -200, pointerId: 1 })

      await advance(500)
      expect(screen.getByText('Coverage degraded')).toBeInTheDocument()
    })
  })
})

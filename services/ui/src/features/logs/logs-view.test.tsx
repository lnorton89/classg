import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log, logStore } from './log-store'
import { LogsView } from './logs-view'

/** Appends are batched on a timer, so every assertion has to advance it first. */
function flush(): void {
  act(() => {
    vi.advanceTimersByTime(300)
  })
}

function addEntries(count: number): void {
  for (let i = 0; i < count; i += 1) log.info('ui', `entry ${i}`)
}

beforeEach(() => {
  vi.useFakeTimers()
  logStore.clear()
  logStore.setLimit(1000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LogsView tail following', () => {
  it('keeps scrolling to new entries after the render cap is reached', () => {
    // The regression this pins down: the follow effect was keyed on
    // visible.length, which pins at RENDER_CAP (400) once the log is that
    // long — so "Following" silently stopped exactly when the log got busy.
    render(<LogsView />)
    addEntries(450)
    flush()

    // The cap is genuinely in force for this test to mean anything.
    expect(
      screen.getByText(/Showing the most recent 400 of 450 matching entries/),
    ).toBeInTheDocument()

    const node = screen.getByRole('log')
    // happy-dom has no layout, so give the container a real-looking height and
    // pretend the operator's viewport is somewhere above the tail.
    Object.defineProperty(node, 'scrollHeight', { value: 5000, configurable: true })
    node.scrollTop = 0

    addEntries(1)
    flush()

    expect(node.scrollTop).toBe(5000)
  })
})

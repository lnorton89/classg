import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log, logStore, LOG_SOURCES, type LogLevel, type LogSource } from './log-store'
import { LogsView } from './logs-view'

/**
 * The narrowing controls live in the URL now, so the route owns them. This
 * stands in for the route: the same state, held locally, so these tests keep
 * exercising the view rather than a router.
 */
function LogsHarness() {
  const [minLevel, setMinLevel] = useState<LogLevel>('info')
  const [sources, setSources] = useState<Set<LogSource>>(() => new Set(LOG_SOURCES))
  const [search, setSearch] = useState('')
  return (
    <LogsView
      minLevel={minLevel}
      onMinLevelChange={setMinLevel}
      sources={sources}
      onSourcesChange={setSources}
      search={search}
      onSearchChange={setSearch}
    />
  )
}

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
    render(<LogsHarness />)
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

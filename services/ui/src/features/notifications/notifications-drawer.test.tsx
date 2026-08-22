import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/lib/api/queries'
import type { Track, TracksResponse } from '@/lib/api/types'

import { NotificationsDrawer } from './notifications-drawer'

// No RouterProvider in these tests, and nothing here exercises navigation --
// only that a cleared row is gone and an uncleared one is not. A span, not an
// anchor: an <a> with no href fails jsx-a11y, and nothing here clicks it.
// Matches the stub in app-shell.test.tsx.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}))

const TRACKS_QUERY_KEY = queryKeys.tracks({
  state: ['CONFIRMED', 'COASTING', 'CLOSED'],
  limit: 100,
})

function track(overrides: Partial<Track> = {}): Track {
  return {
    schema_version: '1.0',
    track_id: 't1',
    state: 'CONFIRMED',
    confidence: 0.82,
    first_seen: '2026-08-11T10:00:00Z',
    last_seen: '2026-08-11T10:05:00Z',
    detection_count: 12,
    ...overrides,
  }
}

function response(...tracks: Track[]): TracksResponse {
  return { tracks, next_cursor: null, total: tracks.length }
}

function mount(tracks: Track[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(TRACKS_QUERY_KEY, response(...tracks))
  return render(
    <QueryClientProvider client={client}>
      <NotificationsDrawer />
    </QueryClientProvider>,
  )
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('NotificationsDrawer', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears a notification via its clear button, after the exit animation finishes', async () => {
    vi.useFakeTimers()
    mount([track({ track_id: 'a', identity: { serial: 'DRONE-A' } })])

    fireEvent.click(screen.getByRole('button', { name: /^Notifications/i }))
    expect(screen.getByText('Drone DRONE-A')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear notification: Drone DRONE-A' }))
    // Still present -- the slide-and-fade plays before the row actually leaves.
    expect(screen.getByText('Drone DRONE-A')).toBeInTheDocument()

    await advance(250)
    expect(screen.queryByText('Drone DRONE-A')).not.toBeInTheDocument()
  })

  it('dismisses a row on a swipe past the threshold', async () => {
    vi.useFakeTimers()
    mount([track({ track_id: 'b', identity: { serial: 'DRONE-B' } })])

    fireEvent.click(screen.getByRole('button', { name: /^Notifications/i }))
    const row = screen.getByText('Drone DRONE-B').closest('[data-notification-id]')
    expect(row).not.toBeNull()
    if (!row) throw new Error('row not found')

    fireEvent.pointerDown(row, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(row, { clientX: -150, pointerId: 1 })
    fireEvent.pointerUp(row, { clientX: -150, pointerId: 1 })

    await advance(250)
    expect(screen.queryByText('Drone DRONE-B')).not.toBeInTheDocument()
  })

  it('snaps back and stays on a short swipe', async () => {
    vi.useFakeTimers()
    mount([track({ track_id: 'c', identity: { serial: 'DRONE-C' } })])

    fireEvent.click(screen.getByRole('button', { name: /^Notifications/i }))
    const row = screen.getByText('Drone DRONE-C').closest('[data-notification-id]')
    if (!row) throw new Error('row not found')

    fireEvent.pointerDown(row, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(row, { clientX: -30, pointerId: 1 })
    fireEvent.pointerUp(row, { clientX: -30, pointerId: 1 })

    await advance(500)
    expect(screen.getByText('Drone DRONE-C')).toBeInTheDocument()
  })

  it('a cleared notification stays cleared across a remount of the drawer', async () => {
    vi.useFakeTimers()
    const trackList = [track({ track_id: 'd', identity: { serial: 'DRONE-D' } })]

    const { unmount } = mount(trackList)
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear notification: Drone DRONE-D' }))
    await advance(250)
    unmount()

    mount(trackList)
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/i }))
    expect(screen.queryByText('Drone DRONE-D')).not.toBeInTheDocument()
    expect(screen.getByText(/everything here has been cleared/i)).toBeInTheDocument()
  })

  it('clearing one notification does not clear a different one', async () => {
    vi.useFakeTimers()
    mount([
      track({ track_id: 'e', identity: { serial: 'DRONE-E' } }),
      track({
        track_id: 'f',
        identity: { serial: 'DRONE-F' },
        first_seen: '2026-08-11T09:00:00Z',
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: /^Notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear notification: Drone DRONE-E' }))
    await advance(250)

    expect(screen.queryByText('Drone DRONE-E')).not.toBeInTheDocument()
    expect(screen.getByText('Drone DRONE-F')).toBeInTheDocument()
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PREFERENCES,
  PreferencesContext,
  type AlertLevel,
} from '@/app/preferences-context'
import { playAlert } from '@/lib/alert-sound'
import { queryKeys } from '@/lib/api/queries'
import type { Track, TracksResponse } from '@/lib/api/types'

import { TrackAlerts } from './track-alerts'

vi.mock('@/lib/alert-sound', () => ({ playAlert: vi.fn() }))

function track(id: string, confidence: number, state: Track['state'] = 'TENTATIVE'): Track {
  return {
    schema_version: '1.0',
    track_id: id,
    state,
    first_seen: '2026-08-17T00:00:00Z',
    last_seen: '2026-08-17T00:00:01Z',
    detection_count: 1,
    confidence,
  }
}

function response(...tracks: Track[]): TracksResponse {
  return { tracks, next_cursor: null, total: tracks.length }
}

/**
 * Seeds the cache before mounting so the component's first list is "history"
 * (the priming pass), then pushes further lists the way the live provider does.
 */
function mount(level: AlertLevel, initial: TracksResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(queryKeys.tracks({}), initial)
  render(
    <QueryClientProvider client={client}>
      <PreferencesContext.Provider
        value={{
          preferences: { ...DEFAULT_PREFERENCES, alertLevel: level },
          setPreference: () => undefined,
          reset: () => undefined,
        }}
      >
        <TrackAlerts />
      </PreferencesContext.Provider>
    </QueryClientProvider>,
  )
  return {
    // React Query batches observer notifications on a setTimeout(0), so the
    // act needs a macrotask hop before the update reaches the component.
    push: (next: TracksResponse) =>
      act(async () => {
        client.setQueryData(queryKeys.tracks({}), next)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }),
  }
}

afterEach(() => vi.mocked(playAlert).mockClear())

describe('TrackAlerts', () => {
  it('stays silent for the priming list', () => {
    mount('any', response(track('t1', 0.9, 'CONFIRMED')))
    expect(playAlert).not.toHaveBeenCalled()
  })

  it('announces a new contact once at the "any" level', async () => {
    const { push } = mount('any', response())
    await push(response(track('t1', 0.2)))
    expect(playAlert).toHaveBeenCalledTimes(1)
    expect(playAlert).toHaveBeenCalledWith('contact')

    await push(response(track('t1', 0.3)))
    expect(playAlert).toHaveBeenCalledTimes(1)
  })

  it('still fires "confirmed" for a track that opened below the threshold', async () => {
    // The regression this pins down: the track was marked announced on its
    // first, tentative appearance, so by the time it crossed 0.6 it had been
    // consumed and "Confirmed only" almost never made a sound.
    const { push } = mount('confirmed', response())
    await push(response(track('t1', 0.3)))
    expect(playAlert).not.toHaveBeenCalled()

    await push(response(track('t1', 0.85, 'CONFIRMED')))
    expect(playAlert).toHaveBeenCalledTimes(1)
    expect(playAlert).toHaveBeenCalledWith('confirmed')
  })

  it('never re-announces a track once it has sounded', async () => {
    const { push } = mount('confirmed', response())
    await push(response(track('t1', 0.3)))
    await push(response(track('t1', 0.85, 'CONFIRMED')))
    await push(response(track('t1', 0.4)))
    await push(response(track('t1', 0.9, 'CONFIRMED')))
    expect(playAlert).toHaveBeenCalledTimes(1)
  })

  it('retires a track that arrives already closed without a sound', async () => {
    const { push } = mount('any', response())
    await push(response(track('t1', 0.9, 'CLOSED')))
    expect(playAlert).not.toHaveBeenCalled()
  })
})

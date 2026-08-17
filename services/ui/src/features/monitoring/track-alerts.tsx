/**
 * Audible notice that something new is up.
 *
 * Mounted once in the app shell and renders nothing. It exists because the
 * realistic way this console is used is *not* being stared at: it sits on a
 * bench or a tripod while the operator does something else, and the whole value
 * of a continuously recording detector is lost if nobody looks up.
 *
 * Fires at most once per track, the first time it qualifies for the chosen
 * level. Re-firing while a drone loiters overhead would train the operator to
 * ignore the sound, which is worse than having no sound at all.
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { playAlert } from '@/lib/alert-sound'
import { tracksQuery } from '@/lib/api/queries'

const CONFIRM_THRESHOLD = 0.6

export function TrackAlerts() {
  const { preferences } = usePreferences()
  const { data } = useQuery(tracksQuery())
  const announced = useRef<Set<string>>(new Set())
  const primed = useRef(false)

  const level = preferences.alertLevel
  const tracks = data?.tracks

  useEffect(() => {
    if (!tracks) return

    // The first list to arrive is history, not news. Record it silently, or
    // enabling the setting would immediately chirp once per existing track.
    if (!primed.current) {
      primed.current = true
      for (const track of tracks) announced.current.add(track.track_id)
      return
    }

    if (level === 'off') {
      // Still track what has been seen, so switching the setting on later does
      // not replay the backlog.
      for (const track of tracks) announced.current.add(track.track_id)
      return
    }

    let fired: 'contact' | 'confirmed' | null = null
    for (const track of tracks) {
      if (announced.current.has(track.track_id)) continue
      if (track.state === 'CLOSED') {
        // Arrived already over: never worth a sound, and never will be.
        announced.current.add(track.track_id)
        continue
      }
      const confirmed = track.confidence >= CONFIRM_THRESHOLD
      // A track that is not yet loud enough for the chosen level must stay
      // eligible, not be consumed: tracks open TENTATIVE and cross the
      // threshold later (log-bridge watches the same transition), so marking
      // it announced here would mean "Confirmed only" almost never fires.
      if (level === 'confirmed' && !confirmed) continue
      announced.current.add(track.track_id)
      // One sound per batch however many tracks appeared: six drones arriving
      // together is one event to look up at, not six.
      if (fired !== 'confirmed') fired = confirmed ? 'confirmed' : 'contact'
    }

    if (fired) playAlert(fired)
  }, [tracks, level])

  return null
}

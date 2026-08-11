import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { HistoryIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { tracksQuery } from '@/lib/api/queries'
import type { Track } from '@/lib/api/types'
import { useFormat } from '@/app/use-format'

/**
 * How many recent flights to list.
 *
 * A count rather than a time window on purpose. A window needs `Date.now()`
 * during render -- impure, and it churns the query key every render -- and
 * "the last 100 flights" is a more useful answer anyway: after a quiet week a
 * 12-hour window shows nothing, which reads as a broken drawer.
 */
const RECENT_LIMIT = 100

/**
 * Recent probable drone flights within range of the receiver.
 *
 * The map answers "what is up right now"; this answers "what has been over the
 * last while", which is the question you actually have after being away from
 * the screen. A continuously-recording detector is only useful if you can find
 * out what it caught while you were not looking.
 *
 * "Probable" is deliberate. A track is evidence a Remote ID broadcast was
 * received nearby, not proof of an aircraft, so nothing here is phrased as
 * certainty and the confidence is always shown.
 */
export function FlightsDrawer() {
  const [open, setOpen] = useState(false)
  const [lastSeenAt, setLastSeenAt] = useState<number>(() => readLastSeen())
  const closeRef = useRef<HTMLButtonElement>(null)

  const { data } = useQuery(
    tracksQuery({
      state: ['CONFIRMED', 'COASTING', 'CLOSED'],
      limit: RECENT_LIMIT,
    }),
  )

  const flights = useMemo(() => {
    const tracks = data?.tracks ?? []
    return [...tracks].sort(
      (a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime(),
    )
  }, [data])

  const unread = flights.filter((f) => new Date(f.first_seen).getTime() > lastSeenAt).length

  // Marking read happens in the click handler, not an effect: it is a
  // consequence of the user opening the drawer, and setting state from an
  // effect just to react to state we already own causes a cascading render.
  function openDrawer() {
    const now = Date.now()
    setLastSeenAt(now)
    writeLastSeen(now)
    setOpen(true)
  }

  // Focus only -- no state -- so the drawer is keyboard-usable on open.
  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  // Escape closes, because a drawer that traps you is worse than no drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={openDrawer}
        aria-label={
          unread > 0 ? `Recent flights, ${unread} new since you last looked` : 'Recent flights'
        }
        className="relative"
      >
        <HistoryIcon aria-hidden />
        {/* The word costs ~50px, which is the difference between the mobile
            header being one row and two. The icon plus the label above keeps it
            identifiable; the accessible name is unchanged either way. */}
        <span className="hidden sm:inline">Flights</span>
        {unread > 0 && (
          <span
            className="bg-primary text-primary-foreground ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold"
            aria-hidden
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
          <button
            className="absolute inset-0 bg-black/50"
            aria-label="Close recent flights"
            onClick={() => setOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Recent flights"
            className="bg-card border-border relative flex h-full w-full max-w-md flex-col border-l shadow-xl"
          >
            <header className="border-border flex items-center justify-between border-b px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Recent flights</h2>
                <p className="text-muted-foreground text-2xs">
                  Probable drone activity in range of the receiver
                </p>
              </div>
              <Button ref={closeRef} variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {flights.length === 0 ? (
                <p className="text-muted-foreground p-4 text-sm">
                  No flights recorded yet. The receiver records continuously, so an empty list
                  means a quiet sky rather than a fault — if in doubt, check the recording
                  indicator and sensor health.
                </p>
              ) : (
                <ul className="divide-border divide-y">
                  {flights.map((flight) => (
                    <li key={flight.track_id}>
                      <FlightRow flight={flight} onNavigate={() => setOpen(false)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  )
}

function FlightRow({ flight, onNavigate }: { flight: Track; onNavigate: () => void }) {
  const format = useFormat()
  const durationMs =
    new Date(flight.last_seen).getTime() - new Date(flight.first_seen).getTime()
  const minutes = Math.max(1, Math.round(durationMs / 60_000))
  const altitude = flight.current?.alt_geodetic_m

  return (
    <Link
      to="/tracks/$trackId"
      params={{ trackId: flight.track_id }}
      onClick={onNavigate}
      className="hover:bg-accent/50 block px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-xs">
          {flight.identity?.serial ?? 'unidentified'}
        </span>
        <span className="text-muted-foreground shrink-0 text-2xs">
          {format.relative(flight.last_seen)}
        </span>
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
        <span>{flight.identity?.vendor ?? 'unknown vendor'}</span>
        <span>{minutes} min</span>
        <span>{flight.detection_count} detections</span>
        {altitude != null && <span>{format.length(altitude)}</span>}
        {/* Always shown: a track is evidence, not proof. */}
        <span>{format.confidence(flight.confidence)} confidence</span>
      </div>
      <StateChip state={flight.state} />
    </Link>
  )
}

/**
 * The same badge the tables use, so a state means one visual thing everywhere.
 * It previously hardcoded palette hues, which read correctly only in dark mode
 * and drifted from the token set the rest of the interface shares.
 */
function StateChip({ state }: { state: Track['state'] }) {
  const variant =
    state === 'CONFIRMED'
      ? ('ok' as const)
      : state === 'COASTING'
        ? ('warn' as const)
        : state === 'CLOSED'
          ? ('muted' as const)
          : ('default' as const)
  return (
    <Badge variant={variant} className="mt-1.5 uppercase">
      {state === 'CONFIRMED' ? 'in flight' : state.toLowerCase()}
    </Badge>
  )
}

const STORAGE_KEY = 'classg.flights.lastSeenAt'

function readLastSeen(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? Number(raw) || 0 : 0
  } catch {
    // Private browsing and similar. An always-unread badge is a far smaller
    // problem than a drawer that will not open.
    return 0
  }
}

function writeLastSeen(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* ignore */
  }
}

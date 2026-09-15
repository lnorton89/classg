/**
 * Search, in the top bar, that resolves.
 *
 * The header already had a magnifier, and it opened the command palette — a
 * list of pages and quick settings with the session's tracks appended. That is
 * a good palette and a bad search: someone reading a serial off the radio
 * wants that airframe's flights, and someone pasting a track id from a report
 * wants that flight, and neither is a "command".
 *
 * So this resolves four things against what the console already holds — a
 * serial or MAC to the aircraft's flights, a track ULID to the flight, an
 * operator's aircraft label to the serial behind it, a sensor id to that
 * sensor — and says which kind each hit is, because "1581F9DE…" looks the same
 * whether it is a serial or the front of a ULID. The deciding is in
 * search-resolver.ts, where it can be tested without a DOM.
 *
 * No endpoint was added. Tracks come from the query cache the list view and
 * the live socket have already filled; labels and sensors are fetched only
 * once somebody actually types.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Kbd } from '@/components/ui/kbd'
import { tracksSearchSchema } from '@/features/tracks/tracks-search'
import { aircraftLabelsQuery, sensorsQuery, tracksQuery } from '@/lib/api/queries'
import type { TracksResponse } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { isApplePlatform } from '@/lib/platform'

import {
  buildSearchIndex,
  resolveSearch,
  SEARCH_KIND_LABEL,
  type SearchHit,
  type SearchTarget,
} from './search-resolver'

/**
 * The id the ⌘K handler focuses. One element carries it — the top bar's — so
 * the shortcut cannot land in the copy inside the closed "More" sheet.
 */
export const GLOBAL_SEARCH_INPUT_ID = 'global-search-input'

/**
 * Long enough that a typed serial is not re-resolved per keystroke, short
 * enough that the list feels like it is following the typing rather than
 * catching up with it.
 */
const DEBOUNCE_MS = 150

/** Matches the notification drawer's, so the two share one cache entry. */
const TRACK_LIMIT = 100

export interface GlobalSearchProps {
  /** Only the top bar's instance takes the shortcut id; the sheet's gets none. */
  inputId?: string
  className?: string
  /** Close the sheet, if this instance is inside one. */
  onNavigate?: () => void
  /**
   * Take focus when mounted. Only the "More" sheet sets it — the sheet was
   * opened to type in. Done with a ref in an effect rather than `autoFocus`,
   * the same way the command palette does it: the attribute is a blunt
   * instrument that fires wherever the element lands, and jsx-a11y is right to
   * refuse it.
   */
  focusOnMount?: boolean
}

export function GlobalSearch({
  inputId,
  className,
  onNavigate,
  focusOnMount = false,
}: GlobalSearchProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [query, setQuery] = useState('')
  const [needle, setNeedle] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const id = setTimeout(() => setNeedle(query), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => () => (blurTimer.current ? clearTimeout(blurTimer.current) : undefined), [])

  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus()
  }, [focusOnMount])

  const searching = query.trim().length > 0

  // Fetched only once somebody types: this component is mounted on every route
  // at every width, and two standing polls to answer a box nobody has touched
  // is exactly the cost the header is supposed to be careful about.
  const labels = useQuery({ ...aircraftLabelsQuery(), enabled: searching })
  const sensors = useQuery({ ...sensorsQuery(), enabled: searching })

  /**
   * The same query the notification drawer already mounts, so this costs no
   * extra request — it is here to make the cache read below REACTIVE. Read
   * imperatively and nothing else, and a track that arrived after the last
   * keystroke would not be searchable until something unrelated re-rendered
   * the header.
   */
  const recentTracks = useQuery(
    tracksQuery({ state: ['CONFIRMED', 'COASTING', 'CLOSED'], limit: TRACK_LIMIT }),
  )

  /**
   * Tracks from the cache rather than a fetch, the same reasoning as the
   * command palette's: the list view and the live stream have already
   * populated it, and a search that waits on the network is a search that
   * feels broken. Reading every `['tracks','list']` entry rather than just the
   * query above picks up the Flights page's full history when it has been
   * opened.
   */
  const index = useMemo(() => {
    const seen = new Map<string, TracksResponse['tracks'][number]>()
    for (const track of recentTracks.data?.tracks ?? []) seen.set(track.track_id, track)
    const entries = queryClient.getQueriesData<TracksResponse>({ queryKey: ['tracks', 'list'] })
    for (const [, data] of entries) {
      for (const track of data?.tracks ?? []) {
        if (!seen.has(track.track_id)) seen.set(track.track_id, track)
      }
    }
    return buildSearchIndex([...seen.values()], labels.data?.labels ?? [], sensors.data ?? [])
  }, [queryClient, labels.data, sensors.data, recentTracks.data])

  const hits = useMemo(() => resolveSearch(needle, index), [needle, index])
  const showList = open && needle.trim().length > 0

  function go(target: SearchTarget) {
    setOpen(false)
    setQuery('')
    setNeedle('')
    onNavigate?.()
    if (target.kind === 'track') {
      void navigate({ to: '/tracks/$trackId', params: { trackId: target.trackId } })
    } else if (target.kind === 'flights') {
      // Through the route's own schema, so this cannot drift from the key the
      // Flights page actually reads.
      void navigate({ to: '/tracks', search: tracksSearchSchema.parse({ q: target.q }) })
    } else {
      void navigate({ to: '/sensors', search: { sensor: target.sensorId } })
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      // Escape closes the list first and clears the box second, so the
      // keystroke that dismisses a result list does not also destroy the query
      // that produced it.
      if (showList) {
        event.preventDefault()
        setOpen(false)
      } else if (query.length > 0) {
        event.preventDefault()
        setQuery('')
      }
      return
    }
    if (!showList || hits.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((old) => (old + 1) % hits.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((old) => (old - 1 + hits.length) % hits.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[active] ?? hits[0]
      if (hit) go(hit.target)
    }
  }

  return (
    <div className={cn('relative min-w-0', className)}>
      <SearchIcon
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
        aria-hidden
      />
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
        aria-label="Search flights, aircraft and sensors"
        aria-keyshortcuts={inputId === GLOBAL_SEARCH_INPUT_ID ? 'Control+K Meta+K' : undefined}
        placeholder="Serial, MAC, flight id, sensor…"
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Deferred: a click on a result blurs the input before the click
          // lands, and closing synchronously unmounts the row out from under
          // the pointer.
          blurTimer.current = setTimeout(() => setOpen(false), 120)
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'border-input bg-background h-9 w-full rounded-md border pr-14 pl-8 text-sm',
          'placeholder:text-muted-foreground transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        )}
      />
      {inputId === GLOBAL_SEARCH_INPUT_ID ? (
        <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
          {isApplePlatform() ? '⌘K' : 'Ctrl K'}
        </Kbd>
      ) : null}

      <div
        id={listId}
        role="listbox"
        aria-label="Search results"
        className={cn(
          'border-border bg-popover text-popover-foreground absolute top-full right-0 left-0 z-50',
          'mt-1 max-h-80 overflow-y-auto rounded-lg border p-1 shadow-lg',
          !showList && 'hidden',
        )}
      >
        {hits.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-center text-xs">
            Nothing matches “{needle.trim()}”. Serial, MAC, flight id, aircraft label and sensor
            id are what this box knows.
          </p>
        ) : (
          hits.map((hit, position) => (
            <HitRow
              key={hit.id}
              id={`${listId}-${position}`}
              hit={hit}
              active={position === active}
              onHover={() => setActive(position)}
              onSelect={() => go(hit.target)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function HitRow({
  id,
  hit,
  active,
  onHover,
  onSelect,
}: {
  id: string
  hit: SearchHit
  active: boolean
  onHover: () => void
  onSelect: () => void
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      // Mouse-DOWN, not click: the input's blur fires first otherwise and the
      // list is gone by the time the click would land.
      onMouseDown={(event) => {
        event.preventDefault()
        onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
        active ? 'bg-accent text-accent-foreground' : 'text-foreground',
      )}
    >
      {/* The kind, always. Twenty hex characters is a serial or the front of a
          flight id and the operator cannot tell which by looking. */}
      <span className="text-muted-foreground w-14 shrink-0 text-2xs uppercase">
        {SEARCH_KIND_LABEL[hit.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{hit.label}</span>
      {hit.detail ? (
        <span className="text-muted-foreground max-w-40 shrink-0 truncate text-2xs">
          {hit.detail}
        </span>
      ) : null}
    </button>
  )
}

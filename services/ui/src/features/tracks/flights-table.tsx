/**
 * The closed-flights table.
 *
 * Deliberately not the TanStack table next door. That one renders a track
 * document — state, confidence, evidence, identity — which is the right shape
 * for the active list, where those columns move. This renders a *flight*, and
 * it needs three things v9's opt-in feature set does not carry here: collapsible
 * aircraft groups, an inline expanded row, and sort keys derived by walking
 * `history[]`. Registering grouping and row-expansion features to get them would
 * cost more bundle on a Pi than the hundred lines below.
 *
 * State and Confidence are absent on purpose: in the closed table they read
 * CLOSED and 60 % on every row (see docs/research/08-tracks-ux.md). They stay on
 * the active table, where they vary and are the point.
 */
import { Link } from '@tanstack/react-router'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'

import { useFormat, type Formatters } from '@/app/use-format'
import { CopyButton } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import type { ReceiverPosition, Track } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { EvidenceChips } from './evidence'
import type { GroupMode } from './flight-filter-bar'
import { groupByAircraft } from './flight-groups'
import {
  aircraftLabel,
  flightDurationS,
  hasOperatorFix,
  maxHeightAglM,
  maxRangeM,
  parseFlightSort,
  sortFlights,
  type FlightSort,
  type FlightSortColumn,
} from './flight-metrics'
import { FlightQuickView } from './flight-quick-view'
import { dayLabel } from './flight-time'
import { PathThumbnail } from './path-thumbnail'

interface FlightColumn {
  id: string
  label: string
  sort?: FlightSortColumn
}

const FLIGHT_COLUMNS: FlightColumn[] = [
  { id: 'start', label: 'Start', sort: 'start' },
  { id: 'duration', label: 'Duration', sort: 'duration' },
  { id: 'path', label: 'Path' },
  { id: 'range', label: 'Max range', sort: 'range' },
  { id: 'agl', label: 'Max AGL', sort: 'agl' },
  { id: 'operator', label: 'Operator' },
  { id: 'detections', label: 'Detections', sort: 'detections' },
  { id: 'rssi', label: 'Peak RSSI', sort: 'rssi' },
]

/**
 * Descending is the useful first press for every one of these: the most recent
 * flight, the longest, the furthest, the highest, the busiest, the loudest.
 */
function nextSort(current: FlightSort, column: FlightSortColumn): FlightSort {
  const parsed = parseFlightSort(current)
  if (parsed.column !== column) return `${column}-desc`
  return parsed.desc ? `${column}-asc` : `${column}-desc`
}

function DetectionsCell({ track }: { track: Track }) {
  const evidence = track.evidence ?? []
  return (
    <Tooltip
      content={
        // Folded in from its own column: "A×2302" beside "2302" was the same
        // number printed twice, and the breakdown is what the count means.
        evidence.length > 0 ? (
          <EvidenceChips evidence={evidence} />
        ) : (
          <span>No evidence recorded for this track.</span>
        )
      }
    >
      <span className="tnum font-mono text-xs underline decoration-dotted underline-offset-2">
        {track.detection_count}
      </span>
    </Tooltip>
  )
}

function OperatorCell({ track }: { track: Track }) {
  return hasOperatorFix(track) ? (
    <span className="text-operator text-xs" title="The aircraft broadcast its pilot's position">
      ✓
    </span>
  ) : (
    <span className="text-muted-foreground text-xs">—</span>
  )
}

function IdentityCell({ track, repeated }: { track: Track; repeated: boolean }) {
  const label = aircraftLabel(track)
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Link
        to="/tracks/$trackId"
        params={{ trackId: track.track_id }}
        // Muted when it repeats the row above: the eye then reads the column as
        // "same aircraft" without the identifier competing with the columns that
        // actually differ. Still a link, still copyable — it is dimmed, not gone.
        className={cn(
          'block truncate font-mono text-xs underline-offset-2 hover:underline',
          repeated ? 'text-muted-foreground/60' : 'text-primary',
        )}
      >
        {label}
      </Link>
      <CopyButton value={label} label="identifier" />
    </span>
  )
}

function flightCell(
  column: FlightColumn,
  track: Track,
  receiver: ReceiverPosition | null,
  format: Formatters,
) {
  switch (column.id) {
    case 'start':
      return (
        <span className="tnum text-xs whitespace-nowrap">
          {format.timestamp(track.first_seen)}
        </span>
      )
    case 'duration': {
      const duration = flightDurationS(track)
      return (
        <span className="tnum font-mono text-xs">
          {duration === null ? '—' : format.duration(duration)}
        </span>
      )
    }
    case 'path':
      return <PathThumbnail track={track} receiver={receiver} />
    case 'range':
      return (
        <span className="tnum font-mono text-xs">
          {format.range(maxRangeM(track, receiver))}
        </span>
      )
    case 'agl':
      return (
        <span className="tnum font-mono text-xs">{format.length(maxHeightAglM(track))}</span>
      )
    case 'operator':
      return <OperatorCell track={track} />
    case 'detections':
      return <DetectionsCell track={track} />
    case 'rssi':
      return (
        <span className="tnum font-mono text-xs">{format.rssi(track.rssi_dbm ?? null)}</span>
      )
    default:
      return null
  }
}

export interface FlightsTableProps {
  tracks: Track[]
  receiver: ReceiverPosition | null
  group: GroupMode
  sort: FlightSort
  onSortChange: (sort: FlightSort) => void
  /** The operator's time-zone choice, for the group headers' date span. */
  utc: boolean
  caption: string
  emptyTitle: string
  emptyDescription?: string
  /** True when a filter is narrowing the set, so the empty state can say so. */
  filtered?: boolean
  /**
   * Which flight's quick view is open, when something outside the table owns
   * that choice — the lanes view above it does, so a bar and a row cannot
   * disagree about which flight is being looked at. Omit both and the table
   * keeps the selection to itself, which is what the plain list wants.
   */
  expandedId?: string | null
  onExpandedChange?: (trackId: string | null) => void
}

export function FlightsTable({
  tracks,
  receiver,
  group,
  sort,
  onSortChange,
  utc,
  caption,
  emptyTitle,
  emptyDescription,
  filtered = false,
  expandedId: controlledExpandedId,
  onExpandedChange,
}: FlightsTableProps) {
  const format = useFormat()
  const [ownExpandedId, setOwnExpandedId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())

  const controlled = controlledExpandedId !== undefined
  const expandedId = controlled ? controlledExpandedId : ownExpandedId
  const setExpandedId = (trackId: string | null) => {
    if (!controlled) setOwnExpandedId(trackId)
    onExpandedChange?.(trackId)
  }

  const sorted = useMemo(() => sortFlights(tracks, sort, receiver), [tracks, sort, receiver])
  const groups = useMemo(
    () => (group === 'aircraft' ? groupByAircraft(sorted) : []),
    [group, sorted],
  )

  const showIdentity = group === 'none'
  const columnCount = FLIGHT_COLUMNS.length + 1 + (showIdentity ? 1 : 0)

  function toggleGroup(key: string) {
    setCollapsed((old) => {
      const next = new Set(old)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (sorted.length === 0) {
    return (
      <EmptyState title={filtered ? 'No flights match the filter' : emptyTitle}>
        {filtered
          ? 'Clear the search box, a facet chip, or the selected day to widen the list.'
          : emptyDescription}
      </EmptyState>
    )
  }

  const rowsFor = (flights: Track[], withIdentity: boolean) =>
    flights.map((track, index) => {
      const previous = flights[index - 1]
      const repeated =
        previous !== undefined && aircraftLabel(previous) === aircraftLabel(track)
      const expanded = expandedId === track.track_id
      return (
        <Fragment key={track.track_id}>
          <tr
            // Read by `scrollFlightIntoView` (flight-row.ts) when something
            // outside the table — the lanes band — picks a flight. The mobile
            // card below carries the same attribute.
            data-flight-id={track.track_id}
            className={cn('hover:bg-accent/30 cursor-pointer', expanded && 'bg-accent/20')}
            // Clicking the row is the mouse affordance; the chevron in the
            // first cell is the same action for the keyboard and for a screen
            // reader, which is why the row itself is not focusable. Clicks that
            // land on the serial link or the copy button are theirs.
            onClick={(event) => {
              if (event.target instanceof HTMLElement && event.target.closest('a,button')) {
                return
              }
              setExpandedId(expanded ? null : track.track_id)
            }}
          >
            <td className="w-8 px-2 py-2 align-middle">
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Hide' : 'Show'} quick view for the flight starting ${format.timestamp(track.first_seen)}`}
                onClick={() => setExpandedId(expanded ? null : track.track_id)}
                className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded"
              >
                {expanded ? (
                  <ChevronDownIcon className="size-3.5" aria-hidden />
                ) : (
                  <ChevronRightIcon className="size-3.5" aria-hidden />
                )}
              </button>
            </td>
            {withIdentity ? (
              // Sticky, because it is the column that says which row is which
              // and the table is wider than a laptop viewport.
              <td className="bg-card/95 sticky left-0 z-10 max-w-48 px-3 py-2 align-middle">
                <IdentityCell track={track} repeated={repeated} />
              </td>
            ) : null}
            {FLIGHT_COLUMNS.map((column) => (
              <td key={column.id} className="px-3 py-2 align-middle">
                {flightCell(column, track, receiver, format)}
              </td>
            ))}
          </tr>
          {expanded ? (
            <tr className="bg-accent/10">
              <td colSpan={columnCount} className="px-3 pb-3">
                <FlightQuickView track={track} receiver={receiver} />
              </td>
            </tr>
          ) : null}
        </Fragment>
      )
    })

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* Cards below lg, the table from lg up -- the same split the active
          table uses, and for the same reason: nine columns need about 60rem
          and a phone has 24. */}
      <ul className="space-y-2 lg:hidden">
        {group === 'aircraft'
          ? groups.map((entry) => (
              <li key={entry.key}>
                <GroupSummary
                  label={entry.label}
                  vendor={entry.vendor}
                  uaType={entry.uaType}
                  flights={entry.flights.length}
                  firstSeenMs={entry.firstSeenMs}
                  lastSeenMs={entry.lastSeenMs}
                  collapsed={collapsed.has(entry.key)}
                  onToggle={() => toggleGroup(entry.key)}
                  utc={utc}
                  className="w-full"
                />
                {collapsed.has(entry.key) ? null : (
                  <ul className="mt-2 space-y-2 pl-3">
                    {entry.flights.map((track) => (
                      <li key={track.track_id}>
                        <FlightCard
                          track={track}
                          receiver={receiver}
                          format={format}
                          showIdentity={false}
                          expanded={expandedId === track.track_id}
                          onToggle={() =>
                            setExpandedId(expandedId === track.track_id ? null : track.track_id)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))
          : sorted.map((track) => (
              <li key={track.track_id}>
                <FlightCard
                  track={track}
                  receiver={receiver}
                  format={format}
                  showIdentity
                  expanded={expandedId === track.track_id}
                  onToggle={() =>
                    setExpandedId(expandedId === track.track_id ? null : track.track_id)
                  }
                />
              </li>
            ))}
      </ul>

      <div className="border-border hidden min-h-0 flex-1 overflow-auto rounded-lg border lg:block">
        <table className="w-full min-w-[60rem] border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-card sticky top-0 z-20">
            <tr className="border-border border-b">
              <th scope="col" className="w-8 px-2 py-2">
                <span className="sr-only">Expand</span>
              </th>
              {showIdentity ? (
                <th
                  scope="col"
                  className="text-muted-foreground bg-card sticky left-0 px-3 py-2 text-xs font-medium whitespace-nowrap"
                >
                  Aircraft
                </th>
              ) : null}
              {FLIGHT_COLUMNS.map((column) => (
                <SortableHeader
                  key={column.id}
                  column={column}
                  sort={sort}
                  zoneLabel={format.zoneLabel}
                  onSortChange={onSortChange}
                />
              ))}
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {group === 'aircraft'
              ? groups.map((entry) => (
                  <Fragment key={entry.key}>
                    <tr className="bg-muted/40">
                      <th scope="colgroup" colSpan={columnCount} className="px-2 py-1.5">
                        <GroupSummary
                          label={entry.label}
                          vendor={entry.vendor}
                          uaType={entry.uaType}
                          flights={entry.flights.length}
                          firstSeenMs={entry.firstSeenMs}
                          lastSeenMs={entry.lastSeenMs}
                          collapsed={collapsed.has(entry.key)}
                          onToggle={() => toggleGroup(entry.key)}
                          utc={utc}
                        />
                      </th>
                    </tr>
                    {collapsed.has(entry.key) ? null : rowsFor(entry.flights, false)}
                  </Fragment>
                ))
              : rowsFor(sorted, true)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortableHeader({
  column,
  sort,
  zoneLabel,
  onSortChange,
}: {
  column: FlightColumn
  sort: FlightSort
  zoneLabel: string
  onSortChange: (sort: FlightSort) => void
}) {
  const parsed = parseFlightSort(sort)
  const sortColumn = column.sort
  const active = sortColumn !== undefined && parsed.column === sortColumn
  const SortIcon = !active ? ChevronsUpDownIcon : parsed.desc ? ArrowDownIcon : ArrowUpIcon
  // The zone lives in the header rather than being repeated in every cell.
  const label = column.id === 'start' ? `${column.label} (${zoneLabel})` : column.label

  return (
    <th
      scope="col"
      aria-sort={
        active
          ? parsed.desc
            ? 'descending'
            : 'ascending'
          : sortColumn !== undefined
            ? 'none'
            : undefined
      }
      className="text-muted-foreground px-3 py-2 text-xs font-medium whitespace-nowrap"
    >
      {sortColumn !== undefined ? (
        <button
          type="button"
          onClick={() => onSortChange(nextSort(sort, sortColumn))}
          className="hover:text-foreground flex items-center gap-1 rounded"
        >
          {label}
          <SortIcon className={cn('size-3', !active && 'opacity-40')} aria-hidden />
        </button>
      ) : (
        label
      )}
    </th>
  )
}

function GroupSummary({
  label,
  vendor,
  uaType,
  flights,
  firstSeenMs,
  lastSeenMs,
  collapsed,
  onToggle,
  utc,
  className,
}: {
  label: string
  vendor: string | null
  uaType: string | null
  flights: number
  firstSeenMs: number | null
  lastSeenMs: number | null
  collapsed: boolean
  onToggle: () => void
  utc: boolean
  className?: string
}) {
  const from = firstSeenMs === null ? null : dayLabel(firstSeenMs, utc)
  const to = lastSeenMs === null ? null : dayLabel(lastSeenMs, utc)
  // One date when the whole group is one day's flying, which is the common case
  // and reads better than "Sep 15 – Sep 15".
  const span = from === null || to === null ? null : from === to ? from : `${from} – ${to}`

  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded px-1 py-1 text-left',
        'hover:bg-accent/40 transition-colors',
        className,
      )}
    >
      {collapsed ? (
        <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="text-foreground truncate font-mono text-xs">{label}</span>
      {vendor !== null || uaType !== null ? (
        <span className="text-muted-foreground truncate text-2xs">
          {[vendor, uaType].filter(Boolean).join(' · ')}
        </span>
      ) : null}
      <span className="text-muted-foreground ml-auto shrink-0 text-2xs whitespace-nowrap">
        {flights} flight{flights === 1 ? '' : 's'}
        {span ? ` · ${span}` : ''}
      </span>
    </button>
  )
}

function FlightCard({
  track,
  receiver,
  format,
  showIdentity,
  expanded,
  onToggle,
}: {
  track: Track
  receiver: ReceiverPosition | null
  format: Formatters
  showIdentity: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const duration = flightDurationS(track)
  return (
    <div
      data-flight-id={track.track_id}
      className={cn(
        'border-border bg-card/40 rounded-lg border px-3 py-2.5',
        expanded && 'border-primary/40 bg-accent/20',
      )}
    >
      {showIdentity ? (
        <div className="mb-2">
          <IdentityCell track={track} repeated={false} />
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-3 text-left"
      >
        <PathThumbnail track={track} receiver={receiver} />
        <span className="min-w-0 flex-1">
          <span className="tnum block truncate text-xs">
            {format.timestamp(track.first_seen)}
          </span>
          <span className="text-muted-foreground block truncate font-mono text-2xs">
            {duration === null ? '—' : format.duration(duration)} ·{' '}
            {format.range(maxRangeM(track, receiver))} · {track.detection_count} det
          </span>
        </span>
        {expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
        )}
      </button>
      <dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground text-2xs">Max AGL</dt>
        <dd className="font-mono">{format.length(maxHeightAglM(track))}</dd>
        <dt className="text-muted-foreground text-2xs">Peak RSSI</dt>
        <dd className="font-mono">{format.rssi(track.rssi_dbm ?? null)}</dd>
        <dt className="text-muted-foreground text-2xs">Operator</dt>
        <dd>
          <OperatorCell track={track} />
        </dd>
      </dl>
      {expanded ? <FlightQuickView track={track} receiver={receiver} /> : null}
    </div>
  )
}

/**
 * Tracks table — TanStack Table v9.
 *
 * v9 (Aug 2026) renamed `useReactTable` to `useTable` and moved feature
 * registration into `tableFeatures({...})`, so nothing here resembles a v8
 * example. The opt-in feature registry is the reason for choosing v9 on a
 * Raspberry Pi: only sorting, filtering and global filtering are compiled in.
 */
import { Link } from '@tanstack/react-router'
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  FlexRender,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, SearchIcon } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'

import { useFormat, useTicker, type Formatters } from '@/app/use-format'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/field'
import { EmptyState } from '@/components/ui/misc'
import { Select } from '@/components/ui/select'
import type { Track, TrackState } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { ConfidenceBar, EvidenceChips, TrackStateBadge } from './evidence'

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
})

const helper = createColumnHelper<typeof features, Track>()

/** Everything a free-text search should match, flattened into one string. */
function searchableIdentity(track: Track): string {
  return [
    track.identity?.serial,
    track.identity?.manufacturer_code,
    track.identity?.vendor,
    track.identity?.model_hint,
    track.identity?.operator_id,
    track.track_id,
    ...(track.identity?.macs ?? []),
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The card view's row labels.
 *
 * Not read from the column's `header`, which is free to be a React node and in
 * one case already is. Short, because these sit in a narrow left column beside
 * the value rather than across the top of a wide table.
 */
function columnLabel(id: string, format: Formatters): string {
  switch (id) {
    case 'state':
      return 'State'
    case 'confidence':
      return 'Confidence'
    case 'evidence':
      return 'Evidence'
    case 'detection_count':
      return 'Detections'
    case 'rssi':
      return 'Peak RSSI'
    case 'last_seen':
      return `Last seen (${format.zoneLabel})`
    case 'position':
      return 'Position'
    default:
      return id
  }
}

/**
 * Columns are built from the active formatters rather than defined once at
 * module scope: unit and time preferences change what a cell says, and a
 * module-level column definition would capture whichever setting happened to be
 * in force when the bundle loaded.
 */
function buildColumns(format: Formatters) {
  return helper.columns([
    helper.accessor(searchableIdentity, {
      id: 'identity',
      header: 'Identity',
      filterFn: 'includesString',
      sortFn: 'alphanumeric',
      cell: (info) => {
        const track = info.row.original
        const serial = track.identity?.serial
        const mac = track.identity?.macs?.[0]
        const primary = serial ?? mac ?? track.track_id
        return (
          <div className="min-w-0">
            <span className="flex min-w-0 items-center gap-1">
              <Link
                to="/tracks/$trackId"
                params={{ trackId: track.track_id }}
                className="text-primary block truncate font-mono text-xs underline-offset-2 hover:underline"
              >
                {primary}
              </Link>
              {/* The identifier is what gets transcribed into a report, so it is
                copyable everywhere it appears rather than only on the detail page. */}
              <CopyButton value={primary} label="identifier" />
            </span>
            <span className="text-muted-foreground block truncate text-2xs">
              {serial && mac
                ? mac
                : track.identity?.vendor
                  ? `vendor ${track.identity.vendor}`
                  : '—'}
            </span>
          </div>
        )
      },
    }),

    helper.accessor('state', {
      id: 'state',
      header: 'State',
      sortFn: 'alphanumeric',
      cell: (info) => <TrackStateBadge state={info.getValue()} />,
    }),

    helper.accessor('confidence', {
      id: 'confidence',
      header: 'Confidence',
      sortFn: 'basic',
      cell: (info) => (
        <div className="flex items-center gap-2">
          <ConfidenceBar confidence={info.getValue()} className="w-14" />
          <span className="font-mono text-xs">{format.confidence(info.getValue())}</span>
        </div>
      ),
    }),

    helper.accessor((track) => (track.evidence ?? []).map((e) => e.class).join(''), {
      id: 'evidence',
      header: 'Evidence',
      filterFn: 'includesString',
      cell: (info) => <EvidenceChips evidence={info.row.original.evidence ?? []} />,
    }),

    helper.accessor('detection_count', {
      id: 'detection_count',
      header: 'Detections',
      sortFn: 'basic',
      cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
    }),

    helper.accessor((track) => track.rssi_dbm ?? null, {
      id: 'rssi',
      // "Peak", because that is what fusion now records here (the strongest
      // sample the track ever produced), and because it matches the wording
      // on the detail page. Tracks recorded before the field was populated
      // still render the dash.
      header: 'Peak RSSI',
      sortFn: 'basic',
      cell: (info) => <span className="font-mono text-xs">{format.rssi(info.getValue())}</span>,
    }),

    helper.accessor((track) => Date.parse(track.last_seen), {
      id: 'last_seen',
      // The zone is in the header rather than repeated in every cell.
      header: `Last seen (${format.zoneLabel})`,
      sortFn: 'basic',
      cell: (info) => (
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {format.when(info.row.original.last_seen)}
        </span>
      ),
    }),

    helper.accessor((track) => (track.current ? 'yes' : 'no'), {
      id: 'position',
      header: 'Position',
      cell: (info) => {
        const current = info.row.original.current
        return current ? (
          <span className="text-muted-foreground font-mono text-2xs whitespace-nowrap">
            {format.coords(current.lat, current.lon)}
          </span>
        ) : (
          // Not a missing value: the aircraft is broadcasting without a GPS fix,
          // which is why it is absent from the map as well.
          <span className="text-warn text-2xs">no fix</span>
        )
      },
    }),
  ])
}

const STATE_OPTIONS: { value: TrackState | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All states' },
  { value: 'TENTATIVE', label: 'Tentative' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'COASTING', label: 'Coasting' },
  { value: 'CLOSED', label: 'Closed' },
]

export interface TracksTableProps {
  tracks: Track[]
  caption?: string
  emptyTitle?: string
  emptyDescription?: string
  showStateFilter?: boolean
  /**
   * States to leave out of the filter dropdown. The Active table is fed an
   * already-partitioned list, so offering CLOSED there always produced an
   * empty table whose copy blamed the search box.
   */
  excludeStates?: TrackState[]
}

export function TracksTable({
  tracks,
  caption = 'Detected drone tracks, sortable by column and filterable by identity and state',
  emptyTitle = 'No tracks',
  emptyDescription = 'Check the sensor health banner before concluding the sky is empty.',
  showStateFilter = true,
  excludeStates,
}: TracksTableProps) {
  const format = useFormat()
  // Ages in this table must keep moving even when no frame arrives. Five
  // seconds rather than one: this re-renders every row, and `formatRelative` is
  // coarse by design, so a per-second tick buys no accuracy an operator can use
  // and costs a full table pass every second on a Pi.
  useTicker(5000)
  const columns = useMemo(() => buildColumns(format), [format])

  const [sorting, setSorting] = useState<SortingState>([{ id: 'last_seen', desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')

  const stateFilter =
    (columnFilters.find((f) => f.id === 'state')?.value as TrackState | undefined) ?? 'ALL'

  const data = useMemo(() => tracks, [tracks])

  const table = useTable({
    features,
    columns,
    data,
    globalFilterFn: 'includesString',
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
  })

  const rows = table.getRowModel().rows

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder="Serial, MAC, vendor, operator ID…"
            aria-label="Filter tracks by identity"
            className="pl-8"
          />
        </div>

        {showStateFilter ? (
          <Select
            aria-label="Filter tracks by state"
            value={stateFilter}
            options={STATE_OPTIONS.filter(
              (option) => option.value === 'ALL' || !excludeStates?.includes(option.value),
            )}
            onValueChange={(value) =>
              setColumnFilters((old) => [
                ...old.filter((f) => f.id !== 'state'),
                ...(value === 'ALL' ? [] : [{ id: 'state', value }]),
              ])
            }
            className="w-40"
          />
        ) : null}

        <p className="text-muted-foreground ml-auto text-xs" aria-live="polite">
          {rows.length} of {tracks.length} tracks
        </p>
      </div>

      {/* Cards below lg, the table from lg up.
          
          Eight columns need about 52rem and a phone has 24, so the table was
          scrolled sideways with Confidence, Evidence, Detections, RSSI, Last
          seen and Position all off-screen -- and a horizontal scroll inside a
          vertically scrolling page is a thing people do not find. The cards
          render the SAME TanStack cells, so sorting, filtering and every
          cell's formatting stay defined once. */}
      <ul className={cn('space-y-2 lg:hidden', rows.length === 0 && 'hidden')}>
        {rows.map((row) => {
          const cells = row.getAllCells()
          const [primary, ...rest] = cells
          return (
            <li key={row.id} className="border-border bg-card/40 rounded-lg border px-3 py-2.5">
              {primary ? (
                <div className="mb-2">
                  <FlexRender cell={primary} />
                </div>
              ) : null}
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
                {rest.map((cell) => (
                  <Fragment key={cell.id}>
                    <dt className="text-muted-foreground text-2xs">
                      {columnLabel(cell.column.id, format)}
                    </dt>
                    <dd className="min-w-0">
                      <FlexRender cell={cell} />
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </li>
          )
        })}
      </ul>

      <div className="border-border hidden min-h-0 flex-1 overflow-auto rounded-lg border lg:block">
        <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-card sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-border border-b">
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  const canSort = header.column.getCanSort()
                  const SortIcon =
                    sorted === 'asc'
                      ? ArrowUpIcon
                      : sorted === 'desc'
                        ? ArrowDownIcon
                        : ChevronsUpDownIcon
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : canSort
                              ? 'none'
                              : undefined
                      }
                      className="text-muted-foreground px-3 py-2 text-xs font-medium whitespace-nowrap"
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="hover:text-foreground flex items-center gap-1 rounded"
                        >
                          <FlexRender header={header} />
                          <SortIcon
                            className={cn('size-3', !sorted && 'opacity-40')}
                            aria-hidden
                          />
                        </button>
                      ) : (
                        <FlexRender header={header} />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-border divide-y">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-accent/30">
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 align-middle">
                    <FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Outside both, because it belongs to neither. It used to sit inside the
          table wrapper, which is now desktop-only -- an empty list on a phone
          would have rendered nothing at all, and "no active tracks" is a
          sentence this interface must never fail to say. */}
      {rows.length === 0 ? (
        <EmptyState title={tracks.length === 0 ? emptyTitle : 'No tracks match the filter'}>
          {tracks.length === 0
            ? emptyDescription
            : // The closed-tracks table has no state dropdown, so its recovery
              // hint must not send anyone hunting for one.
              showStateFilter
              ? 'Clear the search box or the state filter to see all tracks.'
              : 'Clear the search box to see all tracks.'}
        </EmptyState>
      ) : null}
    </div>
  )
}

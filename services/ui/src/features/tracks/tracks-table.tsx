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
import { useMemo, useState } from 'react'

import { Input } from '@/components/ui/field'
import { EmptyState } from '@/components/ui/misc'
import { Select } from '@/components/ui/select'
import type { Track, TrackState } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { formatConfidence, formatRelative, formatRssi } from '@/lib/format'

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

const columns = helper.columns([
  helper.accessor(searchableIdentity, {
    id: 'identity',
    header: 'Identity',
    filterFn: 'includesString',
    sortFn: 'alphanumeric',
    cell: (info) => {
      const track = info.row.original
      const serial = track.identity?.serial
      const mac = track.identity?.macs?.[0]
      return (
        <div className="min-w-0">
          <Link
            to="/tracks/$trackId"
            params={{ trackId: track.track_id }}
            className="text-primary block truncate font-mono text-xs underline-offset-2 hover:underline"
          >
            {serial ?? mac ?? track.track_id}
          </Link>
          <span className="text-muted-foreground block truncate text-[11px]">
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
        <span className="font-mono text-xs">{formatConfidence(info.getValue())}</span>
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
    header: 'RSSI',
    sortFn: 'basic',
    cell: (info) => <span className="font-mono text-xs">{formatRssi(info.getValue())}</span>,
  }),

  helper.accessor((track) => Date.parse(track.last_seen), {
    id: 'last_seen',
    header: 'Last seen',
    sortFn: 'basic',
    cell: (info) => (
      <span className="text-muted-foreground text-xs">
        {formatRelative(info.row.original.last_seen)}
      </span>
    ),
  }),

  helper.accessor((track) => (track.current ? 'yes' : 'no'), {
    id: 'position',
    header: 'Position',
    cell: (info) =>
      info.getValue() === 'yes' ? (
        <span className="text-muted-foreground font-mono text-[11px]">
          {info.row.original.current?.lat.toFixed(4)},{' '}
          {info.row.original.current?.lon.toFixed(4)}
        </span>
      ) : (
        <span className="text-warn text-[11px]">no fix</span>
      ),
  }),
])

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
}

export function TracksTable({
  tracks,
  caption = 'Detected drone tracks, sortable by column and filterable by identity and state',
  emptyTitle = 'No tracks',
  emptyDescription = 'Check the sensor health banner before concluding the sky is empty.',
  showStateFilter = true,
}: TracksTableProps) {
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
            options={STATE_OPTIONS}
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

      <div className="border-border min-h-0 flex-1 overflow-auto rounded-lg border">
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

        {rows.length === 0 ? (
          <EmptyState title={tracks.length === 0 ? emptyTitle : 'No tracks match the filter'}>
            {tracks.length === 0
              ? emptyDescription
              : 'Clear the search box or the state filter to see all tracks.'}
          </EmptyState>
        ) : null}
      </div>
    </div>
  )
}

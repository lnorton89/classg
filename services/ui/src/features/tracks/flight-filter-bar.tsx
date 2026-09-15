/**
 * Search, grouping and facet chips for the flights list.
 *
 * Chips rather than a row of dropdowns, and every option carries its count:
 * the point of a facet is to show what the alternatives ARE and what each
 * would return, which a closed `<select>` hides behind an interaction. Options
 * that would return nothing are not rendered at all — see flightFacets.
 */
import { SearchIcon, XIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'

import { Input } from '@/components/ui/field'
import { Segmented } from '@/components/ui/segmented'
import { cn } from '@/lib/cn'
import { detectionClassInfo } from '@/lib/detection-classes'
import type { Track } from '@/lib/api/types'

import { flightFacets, type FlightFilters } from './flight-filters'

export type GroupMode = 'aircraft' | 'none'

function Chip({
  label,
  count,
  selected,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs transition-colors',
        selected
          ? 'border-primary/40 bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <span className="tnum opacity-60">{count}</span>
      {selected ? <XIcon className="size-3" aria-hidden /> : null}
    </button>
  )
}

function FacetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground w-20 shrink-0 text-2xs">{label}</span>
      {children}
    </div>
  )
}

export function FlightFilterBar({
  tracks,
  filters,
  onFiltersChange,
  group,
  onGroupChange,
  utc,
  resultCount,
}: {
  /** The window's whole loaded set — facet counts are computed against it. */
  tracks: Track[]
  filters: FlightFilters
  onFiltersChange: (next: FlightFilters) => void
  group: GroupMode
  onGroupChange: (group: GroupMode) => void
  utc: boolean
  resultCount: number
}) {
  const facets = useMemo(() => flightFacets(tracks, filters, utc), [tracks, filters, utc])

  /** Picking the option that is already on clears it — a chip is a toggle. */
  function toggle<K extends keyof FlightFilters>(key: K, value: FlightFilters[K]) {
    onFiltersChange({ ...filters, [key]: filters[key] === value ? undefined : value })
  }

  const anyFacet =
    facets.vendor.length > 0 ||
    facets.evidence.length > 0 ||
    facets.operator.length > 0 ||
    facets.duration.length > 0 ||
    facets.detections.length > 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={filters.q ?? ''}
            onChange={(event) =>
              onFiltersChange({ ...filters, q: event.target.value || undefined })
            }
            placeholder="Serial, MAC, vendor, operator ID…"
            aria-label="Filter flights by identity"
            className="pl-8"
          />
        </div>

        <span className="text-muted-foreground text-2xs">Group</span>
        <Segmented
          aria-label="Group flights"
          value={group}
          onValueChange={onGroupChange}
          options={[
            { value: 'aircraft', label: 'Aircraft' },
            { value: 'none', label: 'None' },
          ]}
        />

        <p className="text-muted-foreground ml-auto text-xs" aria-live="polite">
          {resultCount} of {tracks.length} flights
        </p>
      </div>

      {anyFacet ? (
        <div className="flex flex-col gap-1.5">
          {facets.vendor.length > 0 ? (
            <FacetRow label="Vendor">
              {facets.vendor.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  count={option.count}
                  selected={filters.vendor === option.value}
                  onClick={() => toggle('vendor', option.value)}
                />
              ))}
            </FacetRow>
          ) : null}

          {facets.evidence.length > 0 ? (
            <FacetRow label="Evidence">
              {facets.evidence.map((option) => (
                <Chip
                  key={option.value}
                  // The class letter alone is jargon; the short name is what
                  // the evidence chips in the table already say.
                  label={`${option.value} · ${detectionClassInfo(option.value).short}`}
                  count={option.count}
                  selected={filters.evidence === option.value}
                  onClick={() => toggle('evidence', option.value)}
                />
              ))}
            </FacetRow>
          ) : null}

          {facets.operator.length > 0 ? (
            <FacetRow label="Operator">
              {facets.operator.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  count={option.count}
                  selected={filters.operator === option.value}
                  onClick={() => toggle('operator', option.value)}
                />
              ))}
            </FacetRow>
          ) : null}

          {facets.duration.length > 0 ? (
            <FacetRow label="Duration">
              {facets.duration.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  count={option.count}
                  selected={filters.minDurationS === option.value}
                  onClick={() => toggle('minDurationS', option.value)}
                />
              ))}
            </FacetRow>
          ) : null}

          {facets.detections.length > 0 ? (
            <FacetRow label="Detections">
              {facets.detections.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  count={option.count}
                  selected={filters.minDetections === option.value}
                  onClick={() => toggle('minDetections', option.value)}
                />
              ))}
            </FacetRow>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The text equivalent of the map.
 *
 * A WebGL canvas is opaque to a screen reader, so this is not a "nice extra": it
 * is the accessible form of the primary view. It is also genuinely the faster way
 * to read the situation on a phone, so it is visible rather than sr-only.
 */
import { Link } from '@tanstack/react-router'
import { PlaneIcon, SatelliteDishIcon, UserIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/misc'
import type { Detection, Track } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { formatConfidence, formatHeading, formatMetres, formatRelative } from '@/lib/format'

import { ConfidenceBar, EvidenceChips } from '../tracks/evidence'
import { bearingDegrees, distanceMetres } from './geo'

export interface ContactsPanelProps {
  tracks: Track[]
  adsb: Detection[]
  selectedTrackId: string | null
  onSelectTrack: (trackId: string | null) => void
  className?: string
}

export function ContactsPanel({
  tracks,
  adsb,
  selectedTrackId,
  onSelectTrack,
  className,
}: ContactsPanelProps) {
  const plotted = tracks.filter((t) => t.current)
  const unplotted = tracks.filter((t) => !t.current)

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <section aria-labelledby="contacts-drones" className="min-h-0 flex-1 overflow-y-auto">
        <h2
          id="contacts-drones"
          className="text-muted-foreground bg-card/95 sticky top-0 z-10 px-3 py-2 text-xs font-semibold tracking-wide uppercase backdrop-blur"
        >
          Drone tracks ({tracks.length})
        </h2>

        {tracks.length === 0 ? (
          <EmptyState icon={PlaneIcon} title="No tracks">
            Whether that means an empty sky depends on sensor health — see the banner above the
            map.
          </EmptyState>
        ) : (
          <ul className="divide-border divide-y">
            {[...plotted, ...unplotted].map((track) => (
              <li key={track.track_id}>
                <TrackRow
                  track={track}
                  selected={track.track_id === selectedTrackId}
                  onSelect={onSelectTrack}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="contacts-manned" className="border-border max-h-64 border-t">
        <h2
          id="contacts-manned"
          className="text-muted-foreground px-3 py-2 text-xs font-semibold tracking-wide uppercase"
        >
          Manned traffic ({adsb.length})
        </h2>
        {adsb.length === 0 ? (
          <p className="text-muted-foreground px-3 pb-3 text-xs">
            No ADS-B contacts. Manned traffic is shown for airspace context and never
            contributes to a drone&apos;s confidence.
          </p>
        ) : (
          <ul className="divide-border divide-y overflow-y-auto">
            {adsb.map((detection) => (
              <li key={detection.detection_id} className="flex items-center gap-2 px-3 py-2">
                <SatelliteDishIcon className="text-manned size-3.5 shrink-0" aria-hidden />
                <span className="font-mono text-xs">
                  {detection.adsb?.callsign?.trim() || detection.adsb?.icao}
                </span>
                <Badge variant="outline" className="border-manned/40 text-manned">
                  manned
                </Badge>
                <span className="text-muted-foreground ml-auto text-xs">
                  {detection.adsb?.alt_ft != null ? `${detection.adsb.alt_ft} ft` : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function TrackRow({
  track,
  selected,
  onSelect,
}: {
  track: Track
  selected: boolean
  onSelect: (trackId: string | null) => void
}) {
  const name = track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id
  const operator = track.operator
  const current = track.current

  return (
    <div
      className={cn(
        'px-3 py-2.5 transition-colors',
        selected ? 'bg-accent/60' : 'hover:bg-accent/30',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => onSelect(selected ? null : track.track_id)}
          aria-pressed={selected}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate font-mono text-xs font-medium">{name}</span>
          <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            <span>{track.state.toLowerCase()}</span>
            <span aria-hidden>·</span>
            <span>{formatRelative(track.last_seen)}</span>
            {current ? (
              <>
                <span aria-hidden>·</span>
                <span>hdg {formatHeading(current.track_deg)}</span>
                <span aria-hidden>·</span>
                <span>{formatMetres(current.height_agl_m)} AGL</span>
              </>
            ) : (
              <>
                <span aria-hidden>·</span>
                <span className="text-warn">no position reported — not on map</span>
              </>
            )}
          </span>
        </button>
        <Link
          to="/tracks/$trackId"
          params={{ trackId: track.track_id }}
          className="text-primary shrink-0 rounded text-[11px] underline-offset-2 hover:underline"
        >
          Detail
        </Link>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <ConfidenceBar confidence={track.confidence} className="w-20" />
        <span className="text-muted-foreground font-mono text-[11px]">
          {formatConfidence(track.confidence)}
        </span>
        <EvidenceChips evidence={track.evidence ?? []} className="ml-auto" />
      </div>

      {operator && current ? (
        <p className="text-operator mt-1.5 flex items-center gap-1 text-[11px]">
          <UserIcon className="size-3" aria-hidden />
          Operator {Math.round(distanceMetres(current, operator))} m away, bearing{' '}
          {Math.round(bearingDegrees(current, operator))}°
        </p>
      ) : null}
    </div>
  )
}

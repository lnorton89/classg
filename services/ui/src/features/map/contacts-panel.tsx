/**
 * The text equivalent of the map.
 *
 * A WebGL canvas is opaque to a screen reader, so this is not a "nice extra": it
 * is the accessible form of the primary view. It is also genuinely the faster way
 * to read the situation on a phone, so it is visible rather than sr-only.
 */
import { Link } from '@tanstack/react-router'
import { ArchiveIcon, PlaneIcon, SatelliteDishIcon, UserIcon } from 'lucide-react'

import { useFormat, useTicker, type Formatters } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/misc'
import type { Detection, Track } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { ConfidenceBar, EvidenceChips } from '../tracks/evidence'
import { bearingDegrees, distanceMetres } from './geo'

export interface ContactsPanelProps {
  tracks: Track[]
  closedTracks?: Track[]
  /**
   * Settings › Live map. Hides the whole closed section rather than passing an
   * empty list: "Closed tracks (0) — no archived tracks" is a claim about the
   * sky, and it would be a false one whenever the operator has simply chosen
   * not to look at them.
   */
  showClosed?: boolean
  adsb: Detection[]
  selectedTrackId: string | null
  onSelectTrack: (trackId: string | null) => void
  /**
   * ICAO address, because that is what identifies the aircraft — the map's
   * manned markers are keyed the same way, which is what keeps a click on
   * either surface highlighting both.
   */
  selectedMannedIcao: string | null
  onSelectManned: (icao: string | null) => void
  className?: string
}

export function ContactsPanel({
  tracks,
  closedTracks = [],
  showClosed = true,
  adsb,
  selectedTrackId,
  onSelectTrack,
  selectedMannedIcao,
  onSelectManned,
  className,
}: ContactsPanelProps) {
  const format = useFormat()
  // Relative ages are only honest if they advance. On a quiet sky no frame
  // arrives to re-render this panel, so it drives its own clock — slowly, since
  // it redraws every contact row and the ages it shows are coarse anyway.
  useTicker(5000)

  const plotted = tracks.filter((t) => t.current)
  const unplotted = tracks.filter((t) => !t.current)

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <section aria-labelledby="contacts-drones" className="min-h-0 flex-1 overflow-y-auto">
        <h2
          id="contacts-drones"
          className="text-muted-foreground bg-card/95 sticky top-0 z-10 px-3 py-2 text-xs font-semibold tracking-wide uppercase backdrop-blur"
        >
          Active drone tracks ({tracks.length})
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
                  format={format}
                  selected={track.track_id === selectedTrackId}
                  onSelect={onSelectTrack}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {showClosed ? (
        <section
          aria-labelledby="contacts-closed"
          className="border-border flex max-h-64 min-h-0 flex-col border-t"
        >
          <h2
            id="contacts-closed"
            className="text-muted-foreground shrink-0 px-3 py-2 text-xs font-semibold tracking-wide uppercase"
          >
            Closed tracks ({closedTracks.length})
          </h2>
          {closedTracks.length === 0 ? (
            <p className="text-muted-foreground px-3 pb-3 text-xs">
              No archived tracks. Closed tracks remain available here for review.
            </p>
          ) : (
            /*
             * min-h-0 and flex-1 are what make overflow-y-auto mean anything
             * here. Without a bounded height the list just grows: the section's
             * max-h-64 caps the section box while the list overflows straight
             * past it, dragging the document to 9000px in a 600px viewport.
             */
            <ul className="divide-border min-h-0 flex-1 divide-y overflow-y-auto">
              {closedTracks.map((track) => (
                <li key={track.track_id}>
                  <ClosedTrackRow track={track} format={format} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section
        aria-labelledby="contacts-manned"
        className="border-border flex max-h-64 min-h-0 flex-col border-t"
      >
        <h2
          id="contacts-manned"
          className="text-muted-foreground shrink-0 px-3 py-2 text-xs font-semibold tracking-wide uppercase"
        >
          Manned traffic ({adsb.length})
        </h2>
        {adsb.length === 0 ? (
          <p className="text-muted-foreground px-3 pb-3 text-xs">
            No ADS-B contacts. Manned traffic is shown for airspace context and never
            contributes to a drone&apos;s confidence.
          </p>
        ) : (
          <ul className="divide-border min-h-0 flex-1 divide-y overflow-y-auto">
            {adsb.map((detection) => (
              <li key={detection.detection_id}>
                <MannedRow
                  detection={detection}
                  format={format}
                  selected={
                    detection.adsb?.icao !== undefined &&
                    detection.adsb.icao === selectedMannedIcao
                  }
                  onSelect={onSelectManned}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * ADS-B reports ground speed in knots, and `kinematics.speed_mps` is not always
 * filled in for a class D detection. Converting rather than showing nothing
 * keeps the operator's unit preference in charge of the reading — including
 * turning it straight back into knots when they have chosen aviation units.
 */
const MPS_PER_KNOT = 0.5144444444444445

function DetailRow({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('text-right font-mono', tone === 'warn' && 'text-warn')}>{value}</dd>
    </>
  )
}

/**
 * A manned contact, expandable to the rest of what the ADS-B frame carried.
 *
 * The button is both a selection (shared with the map, hence `aria-pressed`)
 * and a disclosure (hence `aria-expanded`): both are true of it, and a screen
 * reader user has no other way to learn that more detail appeared.
 */
function MannedRow({
  detection,
  format,
  selected,
  onSelect,
}: {
  detection: Detection
  format: Formatters
  selected: boolean
  onSelect: (icao: string | null) => void
}) {
  const icao = detection.adsb?.icao
  const callsign = detection.adsb?.callsign?.trim()
  // Tested for emptiness rather than nullishness: a callsign that trims to ""
  // has to fall back to the ICAO address, and `??` would keep the "". Same
  // trap as the marker label in markers.ts.
  const name =
    callsign === undefined || callsign === '' ? (icao ?? detection.detection_id) : callsign
  const position = detection.position
  const kinematics = detection.kinematics
  const groundSpeedKt = detection.adsb?.ground_speed_kt
  const speedMps =
    kinematics?.speed_mps ??
    (groundSpeedKt === null || groundSpeedKt === undefined
      ? null
      : groundSpeedKt * MPS_PER_KNOT)

  const summary = (
    <>
      <SatelliteDishIcon className="text-manned size-3.5 shrink-0" aria-hidden />
      <span className="font-mono text-xs">{name}</span>
      <Badge variant="outline" className="border-manned/40 text-manned">
        manned
      </Badge>
      <span className="text-muted-foreground ml-auto font-mono text-xs">
        {format.altitudeFeet(detection.adsb?.alt_ft)}
      </span>
    </>
  )

  // No ICAO means nothing to key a selection on, and the map skips these for
  // the same reason. A row that highlighted nothing on the map would be a lie
  // about the two views agreeing.
  if (icao === undefined) {
    return <div className="flex items-center gap-2 px-3 py-2">{summary}</div>
  }

  const detailId = `manned-detail-${detection.detection_id}`

  return (
    <div className={cn('transition-colors', selected ? 'bg-accent/60' : 'hover:bg-accent/30')}>
      <button
        type="button"
        onClick={() => onSelect(selected ? null : icao)}
        aria-pressed={selected}
        aria-expanded={selected}
        aria-controls={selected ? detailId : undefined}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {summary}
      </button>

      {selected ? (
        <div id={detailId} className="px-3 pb-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
            <DetailRow
              label="Position"
              value={
                position
                  ? format.coords(position.lat, position.lon)
                  : 'not reported — not on map'
              }
              tone={position ? undefined : 'warn'}
            />
            <DetailRow label="Altitude" value={format.altitudeFeet(detection.adsb?.alt_ft)} />
            {position?.alt_geodetic_m === null ||
            position?.alt_geodetic_m === undefined ? null : (
              <DetailRow label="GNSS altitude" value={format.length(position.alt_geodetic_m)} />
            )}
            <DetailRow label="Ground speed" value={format.speed(speedMps)} />
            <DetailRow label="Heading" value={format.heading(kinematics?.track_deg)} />
            <DetailRow
              label="Vertical rate"
              value={format.speed(kinematics?.vertical_speed_mps)}
            />
            {detection.rf?.rssi_dbm === null || detection.rf?.rssi_dbm === undefined ? null : (
              <DetailRow label="Signal" value={format.rssi(detection.rf.rssi_dbm)} />
            )}
            <DetailRow label="Last heard" value={format.when(detection.ts)} />
          </dl>
          <p className="text-muted-foreground mt-1.5 text-2xs">
            Airspace context only. Never contributes to a drone&apos;s confidence.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function ClosedTrackRow({ track, format }: { track: Track; format: Formatters }) {
  const name = track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id

  return (
    <div className="hover:bg-accent/30 flex items-start gap-2 px-3 py-2.5 transition-colors">
      <ArchiveIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs font-medium">{name}</span>
        <span className="text-muted-foreground mt-0.5 block text-2xs">
          closed {format.relative(track.last_seen)} · {track.detection_count} detections
        </span>
      </div>
      <Link
        to="/tracks/$trackId"
        params={{ trackId: track.track_id }}
        className="text-primary shrink-0 rounded text-2xs underline-offset-2 hover:underline"
      >
        Review
      </Link>
    </div>
  )
}

function TrackRow({
  track,
  format,
  selected,
  onSelect,
}: {
  track: Track
  format: Formatters
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
          <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs">
            <span>{track.state.toLowerCase()}</span>
            <span aria-hidden>·</span>
            <span>{format.when(track.last_seen)}</span>
            {current ? (
              <>
                <span aria-hidden>·</span>
                <span>hdg {format.heading(current.track_deg)}</span>
                <span aria-hidden>·</span>
                <span>{format.length(current.height_agl_m)} AGL</span>
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
          className="text-primary shrink-0 rounded text-2xs underline-offset-2 hover:underline"
        >
          Detail
        </Link>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <ConfidenceBar confidence={track.confidence} className="w-20" />
        <span className="text-muted-foreground font-mono text-2xs">
          {format.confidence(track.confidence)}
        </span>
        <EvidenceChips evidence={track.evidence ?? []} className="ml-auto" />
      </div>

      {operator && current ? (
        <p className="text-operator mt-1.5 flex items-center gap-1 text-2xs">
          <UserIcon className="size-3" aria-hidden />
          Operator {format.range(distanceMetres(current, operator))} away, bearing{' '}
          {format.heading(bearingDegrees(current, operator))}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The flights of a window, as a band of time.
 *
 * This was its own page. It should not have been: it asked the same question
 * the Flights list asks — what happened over this period — and answered it with
 * a second copy of the list's state, which then drifted. Picking a day on the
 * list and switching to the Timeline landed on "the last 24 hours" and quietly
 * lost the day. It is a view of the list now, over the list's window and the
 * list's filters, so the two cannot disagree.
 *
 * What it keeps is the reason the page existed. A track is an interval — it was
 * present from first_seen to last_seen — so the screen a security recorder
 * gives you for motion works here: one bar per flight, packed into lanes, read
 * across it. And the hard part is unchanged. An EMPTY band has three completely
 * different meanings and looks identical in all three:
 *
 *   1. Nothing flew. The system worked and the sky was quiet.
 *   2. Nothing was watching. Recording was paused, or every sensor was down.
 *   3. Something flew and the retention job has since deleted it.
 *
 * Only the first is evidence of a quiet sky. This refuses to draw an empty band
 * without saying which of the three it is looking at — the same rule /health
 * follows, applied to history instead of to the present.
 */
import { useQuery } from '@tanstack/react-query'
import { CircleSlashIcon, HistoryIcon, VideoOffIcon } from 'lucide-react'
import { useMemo } from 'react'

import { useFormat } from '@/app/use-format'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, EmptyState, Skeleton } from '@/components/ui/misc'
import { computeSkyState } from '@/features/health/sky-state'
import { healthQuery, monitoringQuery, settingsQuery } from '@/lib/api/queries'
import type { Track } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { formatGoDuration } from '@/lib/format'

import { EventTimeline } from './event-timeline'
import { packLanes, type TimelineWindow } from './lanes'

export interface FlightLanesProps {
  /** Exactly the flights the table below is showing, filters and all. */
  tracks: Track[]
  /** The list's own span, from `flightWindowMs`. */
  window: TimelineWindow
  /** The flight whose row is open in the list, so a bar and a row agree. */
  selectedId: string | null
  onSelect: (trackId: string | null) => void
  /** True while the first page of history is still in flight. */
  pending?: boolean
  /** True when the window holds more flights than one request can return. */
  truncated?: boolean
}

export function FlightLanes({
  tracks,
  window,
  selectedId,
  onSelect,
  pending = false,
  truncated = false,
}: FlightLanesProps) {
  const format = useFormat()

  const health = useQuery(healthQuery())
  const monitoring = useQuery(monitoringQuery())
  const settings = useQuery(settingsQuery())

  const events = useMemo(() => packLanes(tracks, window), [tracks, window])

  const retention = settings.data?.settings['retention.tracks']?.value
  // Only ever read for `absenceIsEvidence` and the sentence that goes with it,
  // both of which come from sensor health; the count is passed so the degraded
  // wording ("this picture is incomplete" versus "not evidence of an empty
  // sky") still matches what is on screen.
  const skyState = computeSkyState(health.data, tracks.length)
  const recording = monitoring.data?.enabled ?? true

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <HistoryIcon className="size-4" aria-hidden />
          Event band
          <span className="text-muted-foreground w-full text-xs font-normal sm:w-auto">
            {format.timestamp(new Date(window.startMs).toISOString())} —{' '}
            {format.timestamp(new Date(window.endMs).toISOString())}
          </span>
        </CardTitle>
        <CardDescription>
          One bar per flight, spanning first seen to last seen. A bar is where the evidence is,
          not where the aircraft was — a flight whose sensor went quiet stops here rather than
          continuing to now. Picking one opens its row in the list below.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {!recording ? (
          <Alert tone="warn" title="Recording is paused">
            <span className="inline-flex items-start gap-1.5">
              <VideoOffIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                Detections are being discarded rather than stored
                {monitoring.data?.discarded_while_paused
                  ? ` (${monitoring.data.discarded_while_paused} so far)`
                  : ''}
                . A gap in this band from the paused period is not a quiet sky — it is a period
                nobody was recording.
              </span>
            </span>
          </Alert>
        ) : null}

        {pending ? (
          <Skeleton className="h-24 w-full" />
        ) : events.length === 0 ? (
          <EmptyState
            title={
              skyState.absenceIsEvidence
                ? 'Nothing in this window'
                : 'Nothing recorded, and nothing was watching'
            }
          >
            {skyState.absenceIsEvidence
              ? 'Sensors were healthy across this window, so an empty band means an empty sky.'
              : skyState.detail}
          </EmptyState>
        ) : (
          <EventTimeline
            events={events}
            window={window}
            selectedId={selectedId}
            // Clicking the selected bar again clears it — without this the only
            // way out of the selection was picking a different bar.
            onSelect={(track) =>
              onSelect(track.track_id === selectedId ? null : track.track_id)
            }
            formatTime={format.clockBrief}
          />
        )}

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
          <LegendSwatch className="bg-ok/40 border-ok/60" label="confirmed" />
          <LegendSwatch className="bg-primary/30 border-primary/50" label="tentative" />
          <LegendSwatch className="bg-warn/40 border-warn/60" label="coasting" />
          <LegendSwatch
            className="bg-muted-foreground/25 border-muted-foreground/40"
            label="closed"
          />
          <span className="ml-auto">
            {events.length} flight{events.length === 1 ? '' : 's'}
          </span>
        </div>

        {truncated ? (
          <Alert tone="warn" title="This window has more tracks than one page holds">
            The API returns at most 1000 per request, so the band above is the newest 1000 of
            them. Narrow the window to see the rest.
          </Alert>
        ) : null}

        {/* The retention horizon, stated. A band that ends abruptly on the
            left is the purge job, not a quiet period. */}
        {typeof retention === 'string' && retention.length > 0 ? (
          <p className="text-muted-foreground flex items-start gap-1.5 text-2xs leading-relaxed">
            <CircleSlashIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Tracks are kept for {formatGoDuration(retention)}. Anything older has been deleted
              by the retention job, so an empty stretch at the left edge of a long window may be
              purged history rather than a quiet sky.
            </span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block size-2.5 rounded-sm border', className)} aria-hidden />
      {label}
    </span>
  )
}

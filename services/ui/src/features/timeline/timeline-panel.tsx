/**
 * Review what happened, the way an NVR does.
 *
 * Tracks are events: each has a start, an end, and a strength, so the same
 * screen a security recorder gives you for motion works here — a band of time,
 * one bar per event, pick a window and read across it.
 *
 * The hard part is not the drawing. It is that an EMPTY band has three
 * completely different meanings and looks identical in all three:
 *
 *   1. Nothing flew. The system worked and the sky was quiet.
 *   2. Nothing was watching. Recording was paused, or every sensor was down.
 *   3. Something flew and the retention job has since deleted it.
 *
 * Only the first is evidence of a quiet sky. This panel refuses to draw an
 * empty band without saying which of the three it is looking at — the same
 * rule /health follows, applied to history instead of to the present.
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CircleSlashIcon, HistoryIcon, VideoOffIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useFormat } from '@/app/use-format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, EmptyState, Skeleton } from '@/components/ui/misc'
import { computeSkyState } from '@/features/health/sky-state'
import { TracksTable } from '@/features/tracks/tracks-table'
import { healthQuery, monitoringQuery, settingsQuery, tracksQuery } from '@/lib/api/queries'
import { cn } from '@/lib/cn'
import type { Track } from '@/lib/api/types'

import { EventTimeline } from './event-timeline'
import { packLanes } from './lanes'

const HOUR_MS = 3_600_000

interface WindowChoice {
  id: string
  label: string
  spanMs: number
}

const DEFAULT_WINDOW: WindowChoice = { id: '24h', label: '24 hours', spanMs: 24 * HOUR_MS }

const WINDOWS: WindowChoice[] = [
  { id: '1h', label: 'Last hour', spanMs: HOUR_MS },
  { id: '6h', label: '6 hours', spanMs: 6 * HOUR_MS },
  DEFAULT_WINDOW,
  { id: '7d', label: '7 days', spanMs: 7 * 24 * HOUR_MS },
]

/**
 * The page asks for one window's worth of tracks and packs them client-side.
 *
 * Deliberately not a server-side bucketed histogram. A track is a
 * coarse-grained thing — one per aircraft, not one per frame — so a week of
 * them is hundreds of rows, not millions, and the API's existing paging
 * already bounds it. A new aggregate endpoint would be a second definition of
 * "an event" for the store to keep in step with this one.
 */
export function TimelinePanel() {
  const format = useFormat()
  const navigate = useNavigate()

  const [windowId, setWindowId] = useState(DEFAULT_WINDOW.id)
  const [selected, setSelected] = useState<Track | null>(null)

  const choice = WINDOWS.find((w) => w.id === windowId) ?? DEFAULT_WINDOW

  // Anchored on mount and on each window change rather than on every render:
  // a `Date.now()` in the render body makes the bars creep leftward on every
  // repaint, and the axis labels change under the pointer.
  const [anchorMs, setAnchorMs] = useState(() => Date.now())
  const window = useMemo(
    () => ({ startMs: anchorMs - choice.spanMs, endMs: anchorMs }),
    [anchorMs, choice.spanMs],
  )

  const since = new Date(window.startMs).toISOString()
  const tracks = useQuery(tracksQuery({ since, limit: 1000 }))
  const health = useQuery(healthQuery())
  const monitoring = useQuery(monitoringQuery())
  const settings = useQuery(settingsQuery())

  // Memoised so the identity is stable across renders where the query did not
  // refetch; `data?.tracks ?? []` allocates a new array every render and would
  // repack the lanes on each one.
  const list = useMemo(() => tracks.data?.tracks ?? [], [tracks.data])
  const events = useMemo(() => packLanes(list, window), [list, window])

  const retention = settings.data?.settings['retention.tracks']?.value
  const skyState = computeSkyState(health.data, list.length)
  const recording = monitoring.data?.enabled ?? true

  // The API caps a page at 1000. More tracks than that in one window means the
  // band is not the whole story, and saying so beats quietly drawing a subset.
  const truncated = list.length >= 1000

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <HistoryIcon className="size-4" aria-hidden />
            Event band
            <span className="text-muted-foreground text-xs font-normal">
              {format.timestamp(new Date(window.startMs).toISOString())} —{' '}
              {format.timestamp(new Date(window.endMs).toISOString())}
            </span>
          </CardTitle>
          <CardDescription>
            One bar per track, spanning first seen to last seen. A bar is where the evidence is,
            not where the aircraft was — a track whose sensor went quiet stops here rather than
            continuing to now.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Time window" className="flex flex-wrap gap-1">
              {WINDOWS.map((w) => (
                <Button
                  key={w.id}
                  size="sm"
                  variant={w.id === windowId ? 'default' : 'outline'}
                  aria-pressed={w.id === windowId}
                  onClick={() => {
                    setWindowId(w.id)
                    setAnchorMs(Date.now())
                  }}
                >
                  {w.label}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setAnchorMs(Date.now())}
            >
              Jump to now
            </Button>
          </div>

          {!recording ? (
            <Alert tone="warn" title="Recording is paused">
              <span className="inline-flex items-start gap-1.5">
                <VideoOffIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  Detections are being discarded rather than stored
                  {monitoring.data?.discarded_while_paused
                    ? ` (${monitoring.data.discarded_while_paused} so far)`
                    : ''}
                  . A gap in this band from the paused period is not a quiet sky — it is a
                  period nobody was recording.
                </span>
              </span>
            </Alert>
          ) : null}

          {tracks.isPending ? (
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
              selectedId={selected?.track_id ?? null}
              onSelect={setSelected}
              formatTime={format.clock}
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
              {events.length} event{events.length === 1 ? '' : 's'}
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
                Tracks are kept for <code className="font-mono">{retention}</code>. Anything
                older has been deleted by the retention job, so an empty stretch at the left
                edge of a long window may be purged history rather than a quiet sky.
              </span>
            </p>
          ) : null}
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Selected event
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() =>
                  void navigate({
                    to: '/tracks/$trackId',
                    params: { trackId: selected.track_id },
                  })
                }
              >
                Open track
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TracksTable
              tracks={[selected]}
              caption="The track selected on the timeline"
              emptyTitle="Nothing selected"
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Everything in this window</CardTitle>
          <CardDescription>
            The same events as a table, for sorting and filtering. Selecting a bar above
            highlights its row here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TracksTable
            tracks={list}
            caption="Tracks recorded in the selected time window"
            emptyTitle="No tracks in this window"
          />
        </CardContent>
      </Card>
    </div>
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

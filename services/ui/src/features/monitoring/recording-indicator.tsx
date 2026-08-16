import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PauseIcon } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api/client'
import { healthQuery, monitoringQuery, queryKeys } from '@/lib/api/queries'
import type { MonitoringState } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import {
  RECORDING_DESCRIPTION,
  RECORDING_LABEL,
  RECORDING_TONE,
  recordingState,
} from './recording-state'

/**
 * Always-visible recording state, with the control to change it.
 *
 * This sits in the app shell rather than on a settings page on purpose: whether
 * the sky is being watched is the single most important fact about the system,
 * and it should never take a click to find out.
 *
 * Note the asymmetry in the affordances. Recording is the resting state and
 * needs no encouragement, so it renders quietly. Paused is abnormal and is
 * drawn to be noticed -- a system that is not recording must not be able to
 * look like a system that is.
 */
export function RecordingIndicator({ className }: { className?: string }) {
  const queryClient = useQueryClient()
  const { data, isPending } = useQuery(monitoringQuery())
  // Cross-referenced with health on purpose: the switch being on is not the
  // same as anything reaching it.
  const { data: health } = useQuery(healthQuery())
  const [confirming, setConfirming] = useState(false)

  const mutation = useMutation({
    mutationFn: ({ enabled, reason }: { enabled: boolean; reason?: string }) =>
      api.setMonitoring(enabled, reason),
    onSuccess: (state: MonitoringState) => {
      queryClient.setQueryData(queryKeys.monitoring, state)
      setConfirming(false)
    },
  })

  if (isPending || !data) {
    return (
      <span className={cn('text-muted-foreground text-xs', className)} aria-live="polite">
        checking recording state…
      </span>
    )
  }

  const recording = data.enabled
  // The switch being on is not the same as anything reaching it. See
  // recording-state.ts -- intent must never be presented as coverage.
  const state = recordingState(data, health) ?? 'paused'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* The same Badge, height and padding as the stream and system pills
          beside it. It used to be a rounded-full chip of its own size, which
          read as a stray element in the cluster once the label was dropped on
          mobile and only the dot was left.
          Tone still comes from RECORDING_TONE: `ok`, `warn` and `muted` are the
          hues licensed to carry urgency here. Muted rather than destructive for
          paused, because the health pill next to it already carries red for
          absent coverage, and saying it twice trains people to skim past both. */}
      <Badge
        variant={RECORDING_TONE[state]}
        title={RECORDING_DESCRIPTION[state]}
        className="h-7 gap-1.5 px-2"
        // Announced, because a change here is consequential and a screen-reader
        // user should not have to poll a badge to learn recording stopped.
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden
          className={cn(
            // `bg-current` inherits the variant's own colour, so the dot can
            // never drift out of step with the pill around it.
            'size-1.5 shrink-0 rounded-full bg-current',
            // Only a genuinely recording system gets the live pulse: a pulsing
            // dot reads as "working" and must not appear when nothing is.
            RECORDING_TONE[state] === 'ok' && 'animate-pulse',
          )}
        />
        {/* The dot carries the state on a phone -- pulsing green for recording,
            flat grey for paused, amber for on-but-blind -- and the word is the
            widest thing in the header. Hidden visually, never removed: the
            colour of a 6px dot is not a label, so the text stays in the
            accessible name and in the `role="status"` announcement. */}
        <span className="sr-only sm:not-sr-only">{RECORDING_LABEL[state]}</span>
      </Badge>

      {!recording && data.discarded_while_paused > 0 && (
        // A paused system must not be mistakable for a quiet one.
        <span className="text-muted-foreground hidden text-2xs sm:inline">
          {data.discarded_while_paused.toLocaleString()} discarded
        </span>
      )}

      {confirming ? (
        <span className="flex items-center gap-1">
          <Button
            size="sm"
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ enabled: false, reason: 'paused from the web app' })
            }
          >
            Stop recording
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </span>
      ) : recording ? (
        // Confirmed, not a bare toggle: stopping a detector is the one action
        // here whose cost is invisible until you need the data you did not keep.
        //
        // Icon-only on a phone. The word is what pushed the header's status
        // cluster past 360px and wrapped the gear onto its own row; the label
        // survives on the accessible name, so nothing is lost to a screen
        // reader. Resume keeps its word at every width -- a paused system needs
        // the way back to be obvious, not compact.
        <Button
          size="sm"
          variant="ghost"
          aria-label="Pause recording"
          onClick={() => setConfirming(true)}
        >
          <PauseIcon className="sm:hidden" aria-hidden />
          <span className="hidden sm:inline">Pause</span>
        </Button>
      ) : (
        <Button
          size="sm"
          variant="default"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ enabled: true })}
        >
          Resume
        </Button>
      )}
    </div>
  )
}

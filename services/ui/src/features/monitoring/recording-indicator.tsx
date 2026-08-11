import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

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
      <span
        title={RECORDING_DESCRIPTION[state]}
        className={cn(
          'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-semibold',
          // Health tokens, not raw palette colours: `ok`, `warn` and
          // `destructive` are the hues licensed to carry urgency here, and the
          // only ones tuned for both themes.
          RECORDING_TONE[state] === 'ok' && 'bg-ok/12 text-ok',
          // Muted, not destructive: the header's health pill already carries the
          // red for absent coverage. Saying it twice trains people to skim past
          // both.
          RECORDING_TONE[state] === 'muted' && 'bg-muted text-muted-foreground',
          RECORDING_TONE[state] === 'warn' && 'bg-warn/15 text-warn ring-warn/45 ring-1',
        )}
        // Announced, because a change here is consequential and a screen-reader
        // user should not have to poll a badge to learn recording stopped.
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            // Only a genuinely recording system gets the live pulse: a pulsing
            // dot reads as "working" and must not appear when nothing is.
            RECORDING_TONE[state] === 'ok' && 'bg-ok animate-pulse',
            RECORDING_TONE[state] === 'muted' && 'bg-muted-foreground/60',
            RECORDING_TONE[state] === 'warn' && 'bg-warn',
          )}
        />
        {RECORDING_LABEL[state]}
      </span>

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
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Pause
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

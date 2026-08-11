import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { api } from '@/lib/api/client'
import { monitoringQuery, queryKeys } from '@/lib/api/queries'
import type { MonitoringState } from '@/lib/api/types'
import { cn } from '@/lib/cn'

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

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span
        className={cn(
          'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
          recording
            ? 'bg-emerald-500/10 text-emerald-400'
            : 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40',
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
            recording ? 'animate-pulse bg-emerald-400' : 'bg-amber-400',
          )}
        />
        {recording ? 'Recording' : 'Paused'}
      </span>

      {!recording && data.discarded_while_paused > 0 && (
        // A paused system must not be mistakable for a quiet one.
        <span className="text-muted-foreground hidden text-[11px] sm:inline">
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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RotateCcwIcon, SaveIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/field'
import { Alert } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { ApiError, api } from '@/lib/api/client'
import { channelPlanQuery, queryKeys, weightsQuery } from '@/lib/api/queries'
import type { ChannelPlan, DetectionClass, FusionWeights } from '@/lib/api/types'
import { DETECTION_CLASS_ORDER, detectionClassInfo, noisyOr } from '@/lib/detection-classes'
import { PageContainer } from '@/components/layout/page-container'

export const Route = createFileRoute('/config')({
  component: ConfigView,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(channelPlanQuery()),
      context.queryClient.ensureQueryData(weightsQuery()),
    ]),
})

/**
 * Client-side validation mirrors what the API enforces. It is a fast-feedback
 * convenience, not the authority — the PUT still returns per-field 400s and those
 * are surfaced too.
 */
const channelPlanSchema = z.object({
  channels: z
    .array(
      z.object({
        channel: z.number().int().min(1).max(196),
        freq_mhz: z.number().int().min(2000).max(7200),
        weight: z.number().min(0, 'Weight cannot be negative').max(1000),
      }),
    )
    .min(1, 'At least one channel is required'),
})

const weightsSchema = z.object({
  weights: z.record(
    z.string(),
    z
      .number()
      .min(0, 'Weight must be between 0 and 1')
      .max(1, 'Weight must be between 0 and 1'),
  ),
})

function ConfigView() {
  return (
    <PageContainer>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Config</h1>
        <p className="text-muted-foreground text-xs">
          These are calibrated hypotheses, not physical constants. Revise them against measured
          results rather than intuition.
        </p>
      </div>
      <ChannelPlanEditor />
      <FusionWeightsEditor />
    </PageContainer>
  )
}

function ChannelPlanEditor() {
  const queryClient = useQueryClient()
  const { data } = useQuery(channelPlanQuery())
  const [draftOverride, setDraft] = useState<ChannelPlan | null>(null)
  const [errors, setErrors] = useState<Record<number, string>>({})
  const draft = draftOverride ?? data ?? null

  const save = useMutation({
    mutationFn: (body: ChannelPlan) => api.putChannelPlan(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.channelPlan }),
  })
  const notice = save.isSuccess
    ? save.data.restart_required
      ? 'saved-restart'
      : 'saved'
    : null

  if (!draft) return null

  const total = draft.channels.reduce(
    (sum, c) => sum + (Number.isFinite(c.weight) ? c.weight : 0),
    0,
  )
  const apiError = save.error instanceof ApiError ? save.error : null

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = channelPlanSchema.safeParse(draft)
    if (!parsed.success) {
      const next: Record<number, string> = {}
      for (const issue of parsed.error.issues) {
        const index = issue.path[1]
        if (typeof index === 'number') next[index] = issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    save.mutate(draft)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel plan</CardTitle>
        <p className="text-muted-foreground text-xs">
          Remote ID beacons arrive at roughly 1 Hz. Uniform hopping across 13 channels misses
          most of them, so dwell time is allocated in proportion to these weights. The share
          column is what actually matters.
        </p>
      </CardHeader>
      <CardContent>
        {apiError ? (
          <Alert tone="error" title={`Save failed (${apiError.code})`} className="mb-3">
            {apiError.message}
            {apiError.field ? ` (field: ${apiError.field})` : ''}
          </Alert>
        ) : null}
        {notice ? (
          <Alert
            tone={notice === 'saved-restart' ? 'warn' : 'info'}
            title={notice === 'saved-restart' ? 'Saved — restart required' : 'Saved'}
            className="mb-3"
          >
            {notice === 'saved-restart'
              ? 'The sensor must be restarted for this to take effect.'
              : 'Applied without a restart.'}
          </Alert>
        ) : null}

        <form onSubmit={onSubmit}>
          <div className="max-h-96 overflow-auto">
            <table className="w-full min-w-[30rem] text-left text-xs">
              <caption className="sr-only">Weighted channel plan</caption>
              <thead className="bg-card text-muted-foreground sticky top-0">
                <tr className="border-border border-b">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Channel
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Freq
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Weight
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Dwell share
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {draft.channels.map((entry, index) => (
                  <tr key={entry.channel}>
                    <th scope="row" className="py-1.5 pr-3 font-mono font-normal">
                      {entry.channel}
                    </th>
                    <td className="text-muted-foreground py-1.5 pr-3 font-mono">
                      {entry.freq_mhz} MHz
                    </td>
                    <td className="py-1.5 pr-3">
                      <Input
                        type="number"
                        step="0.05"
                        min="0"
                        value={entry.weight}
                        aria-label={`Weight for channel ${entry.channel}`}
                        aria-invalid={errors[index] ? true : undefined}
                        className="h-7 w-24"
                        onChange={(event) => {
                          const weight = Number(event.target.value)
                          setDraft((old) =>
                            old
                              ? {
                                  channels: old.channels.map((c, i) =>
                                    i === index ? { ...c, weight } : c,
                                  ),
                                }
                              : old,
                          )
                        }}
                      />
                      {errors[index] ? (
                        <span role="alert" className="text-destructive block text-[11px]">
                          {errors[index]}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-right font-mono">
                      {total > 0 ? `${((entry.weight / total) * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              <SaveIcon aria-hidden /> {save.isPending ? 'Saving…' : 'Save channel plan'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (data) setDraft(structuredClone(data))
                setErrors({})
              }}
            >
              <RotateCcwIcon aria-hidden /> Reset
            </Button>
            <span className="text-muted-foreground ml-auto text-xs">
              {draft.channels.length} channels · total weight {total.toFixed(2)}
            </span>
          </div>
        </form>

        <p className="text-muted-foreground mt-3 text-[11px]">
          6 GHz is deliberately absent: the US regdb sets NO-IR, which disables passive
          listening, and no drone broadcasts Remote ID there.
        </p>
      </CardContent>
    </Card>
  )
}

function FusionWeightsEditor() {
  const queryClient = useQueryClient()
  const { data } = useQuery(weightsQuery())
  const [draftOverride, setDraft] = useState<FusionWeights | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const draft = draftOverride ?? data ?? null

  const save = useMutation({
    mutationFn: (body: FusionWeights) => api.putWeights(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.weights }),
  })
  const notice = save.isSuccess
    ? save.data.restart_required
      ? 'saved-restart'
      : 'saved'
    : null

  if (!draft) return null

  const apiError = save.error instanceof ApiError ? save.error : null
  const present = DETECTION_CLASS_ORDER.filter((code) => draft.weights[code] !== undefined)
  const exampleAB = noisyOr(
    [draft.weights.A, draft.weights.B].filter((w): w is number => typeof w === 'number'),
  )
  const exampleABC = noisyOr(
    [draft.weights.A, draft.weights.B, draft.weights.C].filter(
      (w): w is number => typeof w === 'number',
    ),
  )

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = weightsSchema.safeParse(draft)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[1]
        if (typeof key === 'string') next[key] = issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    save.mutate(draft)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fusion confidence weights</CardTitle>
        <p className="text-muted-foreground text-xs">
          Evidence classes combine via noisy-OR: 1 − Π(1 − wᵢ). Independent weak signals
          accumulate but never reach certainty, and no single class can be gamed into a false
          confirm.
        </p>
      </CardHeader>
      <CardContent>
        {apiError ? (
          <Alert tone="error" title={`Save failed (${apiError.code})`} className="mb-3">
            {apiError.message}
            {apiError.field ? ` (field: ${apiError.field})` : ''}
          </Alert>
        ) : null}
        {notice ? (
          <Alert tone="info" title="Saved" className="mb-3">
            {notice === 'saved-restart'
              ? 'Fusion must be restarted for this to take effect.'
              : 'Applied without a restart.'}
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-3">
          {present.map((code) => {
            const info = detectionClassInfo(code)
            const value = draft.weights[code] ?? 0
            const inputId = `weight-${code}`
            return (
              <div key={code} className="flex flex-wrap items-center gap-3">
                <Label htmlFor={inputId} className="w-52 shrink-0">
                  <span
                    className={`rounded border px-1 py-px font-mono text-[10px] ${info.chipClass}`}
                  >
                    {code}
                  </span>{' '}
                  {info.label}
                </Label>
                <Input
                  id={inputId}
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={value}
                  aria-invalid={errors[code] ? true : undefined}
                  aria-describedby={`${inputId}-hint`}
                  className="h-8 w-24"
                  onChange={(event) => {
                    const weight = Number(event.target.value)
                    setDraft((old) =>
                      old ? { weights: { ...old.weights, [code]: weight } } : old,
                    )
                  }}
                />
                <Tooltip content={info.justification}>
                  <span
                    id={`${inputId}-hint`}
                    className="text-muted-foreground max-w-sm text-[11px] underline decoration-dotted"
                  >
                    {info.justification.slice(0, 64)}
                    {info.justification.length > 64 ? '…' : ''}
                  </span>
                </Tooltip>
                {errors[code] ? (
                  <span role="alert" className="text-destructive w-full text-[11px]">
                    {errors[code]}
                  </span>
                ) : null}
              </div>
            )
          })}

          <div className="bg-muted/40 border-border rounded-md border p-3 text-xs">
            <p className="font-medium">With these weights:</p>
            <ul className="text-muted-foreground mt-1 space-y-0.5 font-mono">
              <li>A alone → {(draft.weights.A ?? 0).toFixed(2)}</li>
              <li>A + B → {exampleAB.toFixed(3)}</li>
              <li>A + B + C → {exampleABC.toFixed(3)}</li>
              <li>C alone → {(draft.weights.C ?? 0).toFixed(2)}</li>
            </ul>
            <p className="text-muted-foreground mt-2">
              A DJI-OUI MAC with no Remote ID is a hint, not a detection — that is what keeps
              class C low. Independence is assumed and is partly false, since A and B arrive
              from the same radio watching the same aircraft.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              <SaveIcon aria-hidden /> {save.isPending ? 'Saving…' : 'Save weights'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (data) setDraft(structuredClone(data))
                setErrors({})
              }}
            >
              <RotateCcwIcon aria-hidden /> Reset
            </Button>
          </div>
        </form>

        <p className="text-muted-foreground mt-3 text-[11px]">
          Class D (ADS-B) has no weight by design: it never contributes to confidence and is
          used only for airspace context and false-positive suppression.
        </p>
      </CardContent>
    </Card>
  )
}

/** Kept for the type-check: the class list must stay in sync with the schema. */
export type _ConfigClasses = DetectionClass

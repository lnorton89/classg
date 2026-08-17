import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { LocateFixedIcon, RotateCcwIcon, SaveIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/field'
import { Alert } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { ApiError, api } from '@/lib/api/client'
import { channelPlanQuery, queryKeys, settingsQuery, weightsQuery } from '@/lib/api/queries'
import type {
  ChannelPlan,
  DetectionClass,
  FusionWeights,
  ReceiverPosition,
} from '@/lib/api/types'
import { DETECTION_CLASS_ORDER, detectionClassInfo, noisyOr } from '@/lib/detection-classes'

export const Route = createFileRoute('/settings/calibration')({
  component: CalibrationSettings,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(channelPlanQuery()),
      context.queryClient.ensureQueryData(weightsQuery()),
      context.queryClient.ensureQueryData(settingsQuery()),
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

/**
 * The one settings category that is not about this browser.
 *
 * These values live on the Pi, are shared by every client, and change what the
 * system detects — so unlike every other category here they have an explicit
 * save, and saving may require a restart. The banner is doing real work: with
 * the old `/config` page folded into Settings, the route no longer signals the
 * difference on its own.
 */
function CalibrationSettings() {
  return (
    <>
      <Alert tone="info" title="These settings change the receiver, not your view">
        Stored on the Pi and shared by every client. They are calibrated hypotheses, not
        physical constants — revise them against measured results rather than intuition.
      </Alert>
      <ReceiverPositionEditor />
      <ChannelPlanEditor />
      <FusionWeightsEditor />
    </>
  )
}

/**
 * Where the map centres before any track exists to derive a position from.
 * Unlike the browser preferences on Settings › Live map, this is stored on
 * the Pi and shared by every client — the same reason it lives on this page
 * rather than that one.
 */
export function ReceiverPositionEditor() {
  const queryClient = useQueryClient()
  const { data } = useQuery(settingsQuery())
  const setting = data?.settings['map.receiver_position']
  const current = (setting?.value ?? null) as ReceiverPosition | null
  const locked = setting?.source === 'env'

  const [draft, setDraft] = useState<{ lat: string; lon: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const lat = draft?.lat ?? (current ? String(current.lat) : '')
  const lon = draft?.lon ?? (current ? String(current.lon) : '')
  const dirty = draft !== null

  const save = useMutation({
    mutationFn: (raw: string) => api.putSettings({ 'map.receiver_position': raw }),
    onSuccess: () => {
      setDraft(null)
      return queryClient.invalidateQueries({ queryKey: queryKeys.settings })
    },
  })

  const apiError = save.error instanceof ApiError ? save.error : null

  const onSubmit = (event: React.SyntheticEvent) => {
    event.preventDefault()
    const latBlank = lat.trim() === ''
    const lonBlank = lon.trim() === ''
    if (latBlank && lonBlank) {
      setFormError(null)
      save.mutate('')
      return
    }
    // One blank field must be an error the operator sees, never a save:
    // Number('') is 0, so letting it through would silently store latitude 0
    // for every client -- the exact "0 is a real coordinate off the Gulf of
    // Guinea, not unset" lie the rest of the system refuses to tell (fusion
    // treats 0,0 as unset for the same reason; see Settings > Data sources).
    if (latBlank || lonBlank) {
      setFormError(
        `${latBlank ? 'Latitude' : 'Longitude'} is blank. Fill in both fields, or clear both to unset the position.`,
      )
      return
    }
    const latNum = Number(lat)
    const lonNum = Number(lon)
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
      setFormError('Both fields must be decimal degrees.')
      return
    }
    setFormError(null)
    save.mutate(`${latNum},${lonNum}`)
  }

  const useBrowserLocation = () => {
    // navigator.geolocation is undefined on insecure origins — the same trap
    // as navigator.clipboard in copy-button.tsx: a Pi reached over plain http
    // on a LAN address won't have it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!window.isSecureContext || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setDraft({
          lat: String(position.coords.latitude),
          lon: String(position.coords.longitude),
        })
      },
      () => {
        /* denied or unavailable — the fields simply stay as they were */
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Receiver position</CardTitle>
        <p className="text-muted-foreground text-xs">
          Where the map centres before any track gives it a position to derive one from. Leave
          both fields blank to fall back to the browser's own location where the connection is
          secure enough to ask for it, or a world view otherwise.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {locked ? (
          <Alert tone="info" title="Set by the environment">
            CLASSG_RECEIVER_POSITION takes precedence over this field. Unset it to manage this
            value here.
          </Alert>
        ) : null}
        {formError ? (
          <Alert tone="error" title="Not saved">
            {formError}
          </Alert>
        ) : null}
        {apiError ? (
          <Alert tone="error" title={`Save failed (${apiError.code})`}>
            {apiError.message}
          </Alert>
        ) : null}
        {save.isSuccess && !dirty ? (
          <Alert tone="ok" title="Saved">
            Applied immediately — no restart needed.
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="receiver-lat">Latitude</Label>
            <Input
              id="receiver-lat"
              type="number"
              step="any"
              min="-90"
              max="90"
              placeholder="decimal degrees"
              value={lat}
              disabled={locked}
              className="mt-1 h-8 w-36"
              onChange={(event) => setDraft({ lat: event.target.value, lon })}
            />
          </div>
          {/* The format, not an example value. These read "51.4775" and
              "-0.0014" -- Greenwich, and entirely plausible as a real setting.
              In a dark theme the grey of a placeholder against the white of a
              value is a thin thing to hang on, and this is the field that
              decides where the map centres and where the ADS-B query is
              anchored. A console this careful about never implying something
              false about the sky should not show an unset receiver as sitting
              at the Royal Observatory. */}
          <div>
            <Label htmlFor="receiver-lon">Longitude</Label>
            <Input
              id="receiver-lon"
              type="number"
              step="any"
              min="-180"
              max="180"
              placeholder="decimal degrees"
              value={lon}
              disabled={locked}
              className="mt-1 h-8 w-36"
              onChange={(event) => setDraft({ lat, lon: event.target.value })}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={useBrowserLocation}
          >
            <LocateFixedIcon aria-hidden /> Use this browser's location
          </Button>
          <Button type="submit" size="sm" disabled={locked || save.isPending || !dirty}>
            <SaveIcon aria-hidden /> {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null)
                setFormError(null)
              }}
            >
              <RotateCcwIcon aria-hidden /> Reset
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
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

  const onSubmit = (event: React.SyntheticEvent) => {
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
            <table className="w-full min-w-120 text-left text-xs">
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
                        <span role="alert" className="text-destructive block text-2xs">
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

        <p className="text-muted-foreground mt-3 text-2xs">
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

  const onSubmit = (event: React.SyntheticEvent) => {
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
                    className={`rounded border px-1 py-px font-mono text-2xs ${info.chipClass}`}
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
                    className="text-muted-foreground max-w-sm text-2xs underline decoration-dotted"
                  >
                    {info.justification.slice(0, 64)}
                    {info.justification.length > 64 ? '…' : ''}
                  </span>
                </Tooltip>
                {errors[code] ? (
                  <span role="alert" className="text-destructive w-full text-2xs">
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

        <p className="text-muted-foreground mt-3 text-2xs">
          Class D (ADS-B) has no weight by design: it never contributes to confidence and is
          used only for airspace context and false-positive suppression.
        </p>
      </CardContent>
    </Card>
  )
}

/** Kept for the type-check: the class list must stay in sync with the schema. */
export type _CalibrationClasses = DetectionClass

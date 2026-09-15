import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckIcon, CopyIcon, LocateFixedIcon, RotateCcwIcon, SaveIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/field'
import { SettingsGroup } from '@/features/settings/setting-fields'
import { Alert, Skeleton } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { Why } from '@/components/ui/why'
import { ApiError, api } from '@/lib/api/client'
import {
  channelPlanQuery,
  queryKeys,
  sensorsQuery,
  settingsQuery,
  weightsQuery,
} from '@/lib/api/queries'
import { asReceiverPosition } from '@/lib/api/types'
import type { ChannelPlan, DetectionClass, FusionWeights, SensorHealth } from '@/lib/api/types'
import { DETECTION_CLASS_ORDER, detectionClassInfo, noisyOr } from '@/lib/detection-classes'

export const Route = createFileRoute('/settings/calibration')({
  component: CalibrationSettings,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(channelPlanQuery()),
      context.queryClient.ensureQueryData(weightsQuery()),
      context.queryClient.ensureQueryData(settingsQuery()),
      // For the channel plan card: what the receivers report having loaded is
      // the half of that card an operator can act on.
      context.queryClient.ensureQueryData(sensorsQuery()),
    ]),
})

/**
 * Client-side validation mirrors what the API enforces. It is a fast-feedback
 * convenience, not the authority — the PUT still returns per-field 400s and those
 * are surfaced too.
 */
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
 * It used to open on a standing banner saying these values live on the Pi and
 * are shared by every client. The settings layout says that at the top of every
 * receiver-scope page now (`ScopeNote` in `routes/settings.tsx`), so repeating
 * it here cost a card's worth of screen for a sentence already on screen. What
 * was worth keeping out of it — that these are calibrated hypotheses rather
 * than constants — sits on the two cards that are actually numbers to tune.
 */
function CalibrationSettings() {
  return (
    <>
      <ReceiverPositionEditor />
      <ExpectedSensorsCard />
      <DetectionTimingCard />
      <ChannelPlanView />
      <FusionWeightsEditor />
    </>
  )
}

/**
 * Which sensors this unit is supposed to have.
 *
 * This had no field anywhere, and no reachable way to set it on the deployment
 * the project actually ships. The production checklist says to declare every
 * sensor in CLASSG_EXPECTED_SENSORS -- but docker/docker-compose.yml passes
 * Tier 1 only by design (ADR-0007), so that variable never reaches the
 * container, and nothing else offered the setting. Following the instruction
 * as written left the unit undeclared.
 *
 * It matters more than most settings on this page because of how it fails. An
 * undeclared sensor is listed only while it is alive: when it stops it does not
 * turn unhealthy, it disappears, and overall health stays `ok` with one fewer
 * receiver. Nothing announces that moment, so a unit can be down a radio for
 * days with a green console.
 */
export function ExpectedSensorsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Expected sensors</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsGroup
          description={
            <>
              The radios this unit should have, as <code className="font-mono">id:kind</code> or{' '}
              <code className="font-mono">id:kind:optional</code>, comma separated. A declared
              sensor that stops is reported unhealthy; an undeclared one simply vanishes.
            </>
          }
          why={
            <>
              Mark hardware the unit may not have fitted as{' '}
              <code className="font-mono">optional</code>: that keeps health out of a permanent{' '}
              <span className="font-mono">degraded</span> on a build without it, and still
              degrades once the sensor has heartbeated and then gone quiet. The failure mode
              this prevents is the quiet one — overall health stays{' '}
              <span className="font-mono">ok</span> with one fewer receiver, and nothing
              announces the moment it happened.
            </>
          }
          fields={[
            {
              key: 'sensors.expected',
              label: 'Declared sensors',
              kind: 'text',
              hint: 'Reference build: wifi-0:wifi,wifi-1:wifi:optional,sdr-0:sdr:optional',
            },
          ]}
        />
      </CardContent>
    </Card>
  )
}

/**
 * The durations and limits that decide when this system stops believing
 * things.
 *
 * Every one of them was reachable only by editing a settings row through the
 * API or setting an environment variable and restarting -- which meant the
 * numbers that decide when a track closes and when a sensor is called dead
 * were effectively fixed, while the page explaining that they are "calibrated
 * hypotheses, not physical constants" sat directly above them.
 *
 * They belong here rather than under a browser preference because every one of
 * them changes what the system CONCLUDES, not what it shows. The sentence
 * about hypotheses is on the group itself now: it is the one shared
 * explanation these six fields share, rather than a banner at the top of a
 * page that also holds five other cards.
 */
function DetectionTimingCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timing and limits</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SettingsGroup
          description="When this receiver stops believing something. These are calibrated hypotheses, not physical constants — revise them against measured results."
          why={
            <>
              Neither direction is free, and each sounds like the safe one. Shortening the
              sensor threshold makes it quicker to call an adapter dead and quicker to be wrong
              about it; lengthening the track lifetime keeps an aircraft on the screen after the
              evidence for it has stopped arriving.
            </>
          }
          fields={[
            { key: 'sensors.stale_after', label: 'Sensor is unhealthy after', kind: 'text' },
            { key: 'fusion.track_ttl', label: 'Close a track after', kind: 'text' },
            {
              key: 'fusion.resume_within',
              label: 'Resume a closed flight within',
              kind: 'text',
              hint: 'Heard again airborne inside this window, an aircraft rejoins the track it left. 0 turns it off.',
            },
            {
              key: 'fusion.max_history',
              label: 'Position history per track',
              kind: 'number',
              hint: 'Points kept per track. The trail on the map and the history table both read this.',
            },
            {
              key: 'spectrum.sweep_timeout',
              label: 'Abandon a sweep after',
              kind: 'text',
              hint: 'A wedged USB device must not hold the radio away from ADS-B for ever.',
            },
            {
              key: 'capture.analyze_timeout',
              label: 'Abandon a capture analysis after',
              kind: 'text',
              hint: 'Raise it for large captures; bounded so a wedged parse cannot hold a request open for ever.',
            },
          ]}
        />
      </CardContent>
    </Card>
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
  const current = asReceiverPosition(setting?.value)
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
          Where this unit stands. It centres the map before any track exists to derive a
          position from, and it anchors the network ADS-B query.
        </p>
        <Why label="What happens if I leave it blank?" className="mt-1">
          Both fields blank falls back to the browser&rsquo;s own location where the connection
          is secure enough to ask for it, and a world view otherwise. One field blank is refused
          rather than saved: <code className="font-mono">0</code> is a real coordinate in the
          Gulf of Guinea, not an absence, and the rest of the system treats it as unset for
          exactly that reason.
        </Why>
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
            <>
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
              {/* The same words the grouped settings use, for the same reason:
                  a disabled-to-enabled Save answers "is there anything to
                  write", not "did that keystroke register". */}
              <p className="text-warn text-xs font-medium" role="status">
                Unsaved changes
              </p>
            </>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * The recorded plan, in the exact shape the receivers' files use -- flow
 * mappings under a `channels:` key, matching services/sensor-wifi/config/
 * channels-*.yaml. The point of the copy button is paste-without-translation,
 * so the format is the file's, not JSON's.
 */
export function channelPlanYaml(plan: ChannelPlan): string {
  const rows = plan.channels.map(
    (c) =>
      `  - { channel: ${String(c.channel)}, freq_mhz: ${String(c.freq_mhz)}, weight: ${
        Number.isInteger(c.weight) ? c.weight.toFixed(1) : String(c.weight)
      } }`,
  )
  return ['channels:', ...rows, ''].join('\n')
}

/** The plan file a Wi-Fi receiver reports having loaded, from its heartbeat. */
function loadedPlan(sensor: SensorHealth): {
  file: string | null
  widened: boolean
  widenedForPeer: boolean
} {
  const detail = sensor.detail ?? {}
  const file = typeof detail.plan === 'string' ? detail.plan : null
  return {
    file,
    widened: detail.plan_fallback === true,
    widenedForPeer: detail.plan_widened_for_peer === true,
  }
}

/**
 * The channel plan, read-only, in two halves: what the radios loaded, and what
 * is recorded here.
 *
 * This was an editable weight-per-channel table with a Save, and the card's own
 * banner said the Save changed nothing on a running receiver — which it did
 * not, and never could. Sensors publish and subscribe to nothing (ADR-0002) and
 * the hopper reads its channel file from disk at startup, so a restart re-reads
 * that file rather than this. Nor is there one file: the two deployed receivers
 * run a different plan each.
 *
 * An editor whose Save is disclaimed by the paragraph above it is the worst
 * kind of control — every affordance of a thing that works, and none of the
 * effect. What an operator actually needs from this card is the comparison:
 * which plan each radio is scanning right now, against the plan somebody
 * intended, in the exact YAML those files take. So the inputs are gone, the
 * loaded plans lead, and the copy button is the one action left, because it is
 * the only one that moves the intended plan any closer to being the real one.
 *
 * Deliberately NOT built: a button that writes these files. It would need a
 * write path from the API container into each sensor's config directory and a
 * restart of a detector that is currently watching the sky, and the honest
 * version of that is a deployment step, not a settings page.
 */
export function ChannelPlanView() {
  const { data: plan } = useQuery(channelPlanQuery())
  const { data: sensors } = useQuery(sensorsQuery())
  const [copiedYaml, setCopiedYaml] = useState(false)

  const wifi = (sensors ?? []).filter((sensor) => sensor.sensor_kind === 'wifi')

  const copyAsYaml = () => {
    if (!plan) return
    // Undefined on insecure origins -- same trap as copy-button.tsx.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!navigator.clipboard) return
    void navigator.clipboard
      .writeText(channelPlanYaml(plan))
      .then(() => {
        setCopiedYaml(true)
        setTimeout(() => setCopiedYaml(false), 1600)
      })
      .catch(() => setCopiedYaml(false))
  }

  const total = plan
    ? plan.channels.reduce((sum, c) => sum + (Number.isFinite(c.weight) ? c.weight : 0), 0)
    : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel plan</CardTitle>
        <p className="text-muted-foreground text-xs">
          Remote ID beacons arrive at roughly 1 Hz, so dwell time is allocated in proportion to
          a weight per channel rather than swept uniformly. Each receiver reads its plan from a
          file on the Pi; this page can show both, and change neither.
        </p>
        <Why label="Why can this page not apply a plan?" className="mt-1">
          The hopper reads its channel file from disk at startup and sensors subscribe to
          nothing (ADR-0002), so there is no path from the database to a running radio — not
          even across a restart, which re-reads the same file. Nor is there one file:{' '}
          <code className="font-mono">config/channels-primary.yaml</code> pins wifi-0 to the
          Remote ID channels while <code className="font-mono">config/channels-sweep.yaml</code>{' '}
          gives wifi-1 the rest, and a receiver that finds itself alone loads{' '}
          <code className="font-mono">config/channels.yaml</code> because neither split plan
          covers the spectrum on its own. Copy the YAML below into the file you mean to change,
          then restart that sensor.
        </Why>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <section aria-labelledby="loaded-plans" data-density-group>
          <h3 id="loaded-plans" className="text-sm font-semibold">
            Loaded by the receivers
          </h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            From each Wi-Fi sensor&rsquo;s own heartbeat. This is what is actually being
            scanned.
          </p>
          {wifi.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-xs">
              No Wi-Fi receiver is heartbeating, so nothing can say which plan is loaded. The{' '}
              <Link to="/sensors" className="underline underline-offset-2">
                Sensors
              </Link>{' '}
              page is where a missing radio shows up.
            </p>
          ) : (
            <dl className="divide-border/60 mt-2 divide-y text-xs">
              {wifi.map((sensor) => {
                const { file, widened, widenedForPeer } = loadedPlan(sensor)
                return (
                  <div
                    key={sensor.sensor_id}
                    data-density-row
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
                  >
                    <dt className="font-mono font-medium">{sensor.sensor_id}</dt>
                    <dd className="font-mono">
                      {file ?? (
                        <span className="text-muted-foreground font-sans">
                          not reported on its heartbeat
                        </span>
                      )}
                    </dd>
                    {widened || widenedForPeer ? (
                      <dd className="text-warn w-full text-2xs">
                        {widened
                          ? 'Widened to the full plan — it found itself alone.'
                          : 'Widened while its peer is busy.'}
                      </dd>
                    ) : null}
                  </div>
                )
              })}
            </dl>
          )}
        </section>

        <section aria-labelledby="recorded-plan" data-density-group>
          <h3 id="recorded-plan" className="text-sm font-semibold">
            Recorded here — intended, not applied
          </h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            The plan stored on this unit as the one somebody meant it to run. No receiver reads
            it; the dwell share column is what the weights amount to.
          </p>

          {!plan ? (
            <Skeleton className="mt-2 h-24 w-full" />
          ) : (
            <>
              <div className="mt-2 max-h-96 overflow-auto">
                <table className="w-full min-w-80 text-left text-xs">
                  <caption className="sr-only">Recorded weighted channel plan</caption>
                  <thead className="bg-card text-muted-foreground sticky top-0">
                    <tr className="border-border border-b">
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        Channel
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        Freq
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                        Weight
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Dwell share
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {plan.channels.map((entry) => (
                      <tr key={entry.channel}>
                        <th scope="row" className="py-1.5 pr-3 font-mono font-normal">
                          {entry.channel}
                        </th>
                        <td className="text-muted-foreground py-1.5 pr-3 font-mono">
                          {entry.freq_mhz} MHz
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono">{entry.weight}</td>
                        <td className="py-1.5 text-right font-mono">
                          {total > 0 ? `${((entry.weight / total) * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={copyAsYaml}>
                  {copiedYaml ? (
                    <CheckIcon className="text-ok" aria-hidden />
                  ) : (
                    <CopyIcon aria-hidden />
                  )}
                  {copiedYaml ? 'Copied' : 'Copy as YAML'}
                </Button>
                <span className="text-muted-foreground ml-auto text-xs">
                  {plan.channels.length} channels · total weight {total.toFixed(2)}
                </span>
              </div>
            </>
          )}
        </section>

        <p className="text-muted-foreground text-2xs">
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
  // No restart_required branch here, unlike every other editor on this page:
  // fusion has no path to these values at all, so "restart to apply" would be
  // a promise the system cannot keep.
  const saved = save.isSuccess

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
          How much each class of evidence is worth. Calibrated hypotheses, not constants —
          revise them against measured results rather than intuition.
        </p>
        <Why label="How do the classes combine?" className="mt-1">
          Noisy-OR: 1 − Π(1 − wᵢ). Independent weak signals accumulate but never reach
          certainty, and no single class can be gamed into a false confirm. Independence is
          assumed and is partly false, since A and B arrive from the same radio watching the
          same aircraft.
        </Why>
      </CardHeader>
      <CardContent>
        {/* Kept at full Alert weight, unlike the rest of this page's prose:
            this is the fact that decides whether the editor below does
            anything, and it must not be skimmable. */}
        <Alert tone="warn" title="Recorded here, compiled into fusion" className="mb-3">
          Fusion runs the weights compiled into it and reads nothing back from here, so editing
          these records the intended weights rather than changing the confidence of any track on
          screen — including after a restart.
        </Alert>
        {apiError ? (
          <Alert tone="error" title={`Save failed (${apiError.code})`} className="mb-3">
            {apiError.message}
            {apiError.field ? ` (field: ${apiError.field})` : ''}
          </Alert>
        ) : null}
        {saved ? (
          <Alert tone="warn" title="Recorded — not applied" className="mb-3">
            Stored as the intended weights. The confidence numbers on screen are unchanged.
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
              class C low.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              <SaveIcon aria-hidden />{' '}
              {save.isPending ? 'Recording…' : 'Record intended weights'}
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

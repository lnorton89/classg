/**
 * Controls bound to a Tier 2 setting by key.
 *
 * Two properties are worth stating, because both are load-bearing:
 *
 * **The help text comes from the API.** Every registry entry carries a `doc`
 * string, and these render it rather than repeating it. Copy retyped here would
 * drift from the seed the moment either changed, and the version an operator
 * reads would stop matching the version that decides behaviour.
 *
 * **An env-held value is shown, not hidden.** ADR-0007's rule is that a setting
 * overridden in the environment renders read-only *with the reason* — a
 * disabled input the operator can still read beats an absent one, because the
 * question being asked is "why is this value what it is".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LockIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { FormField, Input } from '@/components/ui/field'
import { Alert } from '@/components/ui/misc'
import { Switch } from '@/components/ui/switch'
import { Why } from '@/components/ui/why'
import { ApiError, api } from '@/lib/api/client'
import { queryKeys, settingsQuery } from '@/lib/api/queries'
import type { SettingValue } from '@/lib/api/types'

export interface FieldSpec {
  key: string
  label: string
  kind: 'switch' | 'text' | 'number'
  placeholder?: string
  /** Overrides the registry's `doc` where this page needs stronger wording. */
  hint?: ReactNode
}

/**
 * The registry stores everything as one string; render it as one too.
 *
 * "Everything" was not quite everything. The API parses each setting into its
 * typed form before serialising, so most keys arrive as the scalar they went in
 * as -- but `sensors.expected` comes back as an ARRAY of decoded declarations,
 * and this returned '' for it. The field rendered empty on a unit that had the
 * setting, which reads as "not configured" for the one setting whose whole job
 * is saying which sensors exist.
 *
 * Worth knowing how that shipped: the test mocked the value as the string a
 * client sends on the way IN, not the array the API sends on the way OUT, so it
 * asserted against its own fixture rather than the contract. The mock is fixed
 * alongside this.
 */
function asText(setting: SettingValue | undefined): string {
  const value = setting?.value
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (Array.isArray(value)) return value.map(sensorDeclText).filter(Boolean).join(',')
  return ''
}

/**
 * One `sensors.expected` entry, back in the `id:kind[:optional]` form the API
 * accepts on a PUT. Round-tripping matters more than prettiness here: whatever
 * this renders is what an operator edits and sends back.
 */
function sensorDeclText(decl: unknown): string {
  if (typeof decl !== 'object' || decl === null) return ''
  const d = decl as { sensor_id?: unknown; sensor_kind?: unknown; optional?: unknown }
  if (typeof d.sensor_id !== 'string' || typeof d.sensor_kind !== 'string') return ''
  return `${d.sensor_id}:${d.sensor_kind}${d.optional === true ? ':optional' : ''}`
}

function isLocked(setting: SettingValue | undefined): boolean {
  return setting?.source === 'env' || setting?.mutable === false
}

/**
 * A group of settings with one Save.
 *
 * Deferred rather than instant-apply, matching the rest of the "This receiver"
 * scope: these are stored on the Pi, shared by every client, and can change
 * what the system detects. A toggle that reconfigured a detector the moment a
 * thumb brushed it would be the wrong affordance.
 *
 * The group is also the unit of explanation. Every field used to carry its own
 * paragraph, which on a page of six fields is six paragraphs between an
 * operator and the thing they came to change — so the shared reasoning belongs
 * to `description` (one or two lines) or, where it is background rather than
 * instruction, to `why`. What is left on a field is a `hint`: one line, or the
 * registry's own `doc`.
 *
 * Save sits at the foot of the group it saves and nowhere else, because the
 * question "what is this button about to write" has to be answerable without
 * scrolling.
 */
export function SettingsGroup({
  title,
  description,
  why,
  saveLabel = 'Save',
  fields,
  children,
}: {
  /** Heading, when a card holds more than one group. */
  title?: string
  /** The one shared explanation for everything in the group. */
  description?: ReactNode
  /** Background the operator needs once, folded away. */
  why?: ReactNode
  saveLabel?: string
  fields: FieldSpec[]
  children?: ReactNode
}) {
  const queryClient = useQueryClient()
  const { data } = useQuery(settingsQuery())
  const [draft, setDraft] = useState<Record<string, string>>({})
  // What has been stored but is not yet running.
  //
  // GET serves the *running* configuration, because the process assembles its
  // config in memory at startup — so a saved value does not come back in the
  // refetch. Clearing the draft on success therefore made the control spring
  // back to its old state, which reads as "the save failed". These are kept
  // and rendered instead, under a note saying they are pending.
  const [pending, setPending] = useState<Record<string, string>>({})
  const [restartRequired, setRestartRequired] = useState(false)

  const save = useMutation({
    mutationFn: (updates: Record<string, string>) => api.putSettings(updates),
    onSuccess: (response, updates) => {
      setPending((p) => ({ ...p, ...updates }))
      setRestartRequired(response.restart_required)
      setDraft({})
      return queryClient.invalidateQueries({ queryKey: queryKeys.settings })
    },
  })

  const dirty = Object.keys(draft).length > 0
  const apiError = save.error instanceof ApiError ? save.error : null
  // The API reports which field a 400 belongs to, so the message lands on the
  // input that caused it rather than as a banner the operator has to map back.
  const fieldError = (key: string) => (apiError?.field === key ? apiError.message : null)

  // Draft beats pending beats running: what you typed, then what you saved,
  // then what the process is actually using.
  const valueOf = (key: string) => draft[key] ?? pending[key] ?? asText(data?.settings[key])

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (dirty) save.mutate(draft)
      }}
    >
      {title || description || why ? (
        <div className="flex flex-col gap-1.5" data-density-group>
          {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
          {description ? (
            <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
              {description}
            </p>
          ) : null}
          {why ? <Why>{why}</Why> : null}
        </div>
      ) : null}

      {fields.map((field) => {
        const setting = data?.settings[field.key]
        const locked = isLocked(setting)
        const hint = field.hint ?? setting?.doc
        const value = valueOf(field.key)

        if (field.kind === 'switch') {
          const error = fieldError(field.key)
          return (
            <div key={field.key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">{field.label}</p>
                {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
                <LockNote locked={locked} />
                {/* A switch has no FormField wrapper to carry its error, so it
                    renders one itself. Without this a field-scoped 400 on a
                    boolean is invisible: the save fails and the page looks
                    exactly as it did before. */}
                {error ? (
                  <p role="alert" className="text-down mt-1 text-xs">
                    {error}
                  </p>
                ) : null}
              </div>
              <Switch
                checked={value === 'true'}
                disabled={locked}
                aria-label={field.label}
                onCheckedChange={(checked) =>
                  setDraft((d) => ({ ...d, [field.key]: checked ? 'true' : 'false' }))
                }
              />
            </div>
          )
        }

        return (
          <FormField
            key={field.key}
            label={field.label}
            error={fieldError(field.key)}
            hint={
              <>
                {hint}
                <LockNote locked={locked} />
              </>
            }
          >
            {(props) => (
              <Input
                {...props}
                type={field.kind === 'number' ? 'number' : 'text'}
                inputMode={field.kind === 'number' ? 'decimal' : undefined}
                step={field.kind === 'number' ? 'any' : undefined}
                value={value}
                readOnly={locked}
                disabled={locked}
                placeholder={field.placeholder}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, [field.key]: event.target.value }))
                }
              />
            )}
          </FormField>
        )
      })}

      {children}

      {apiError && !apiError.field ? (
        <Alert tone="warn" title="Could not save">
          {apiError.message}
        </Alert>
      ) : null}

      {Object.keys(pending).length > 0 && !dirty ? (
        <Alert
          tone={restartRequired ? 'warn' : 'ok'}
          title={restartRequired ? 'Saved — not running yet' : 'Saved'}
        >
          {restartRequired
            ? 'Stored on the Pi. The process assembled its configuration at startup, so it is still running the previous value; the fields above show what it will use once restarted.'
            : 'Stored on the Pi and in effect.'}
        </Alert>
      ) : null}

      {/* Dirty state as a word, not only as an enabled button. A disabled Save
          answers "is there anything to write"; it does not answer "did that
          keystroke register", which is the question an operator who has just
          typed into one of six fields is actually asking. */}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : saveLabel}
        </Button>
        {dirty ? (
          <p className="text-warn text-xs font-medium" role="status">
            Unsaved changes
          </p>
        ) : null}
      </div>
    </form>
  )
}

function LockNote({ locked }: { locked: boolean }) {
  if (!locked) return null
  return (
    <span className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
      <LockIcon className="size-3" aria-hidden />
      Held in the environment — a saved value would be ignored by the process that reads it.
    </span>
  )
}

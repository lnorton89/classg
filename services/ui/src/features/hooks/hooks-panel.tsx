/**
 * Alert rules: when X happens, do Y.
 *
 * Two things this UI has to get right, both of which are about not lying:
 *
 * A write-only secret reads back as a placeholder. Sending that placeholder
 * back on save means "unchanged" — so editing a rule's name does not silently
 * overwrite its bearer token with bullet characters. The field is left exactly
 * as the server returned it unless the operator types something new.
 *
 * The cooldown is per rule AND per subject, and the copy says so. An operator
 * who reads "5 minute cooldown" as "at most one alert every five minutes" will
 * be surprised when two drones produce two alerts — which is the correct
 * behaviour and the whole reason it is keyed that way.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlayIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { useFormat } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SettingsGroup } from '@/features/settings/setting-fields'
import { FormField, Input } from '@/components/ui/field'
import { Alert, EmptyState, Skeleton } from '@/components/ui/misc'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ApiError, api } from '@/lib/api/client'
import { hookDeliveriesQuery, hookRulesQuery, queryKeys } from '@/lib/api/queries'
import { SECRET_PLACEHOLDER } from '@/lib/api/types'
import type {
  HookAction,
  HookDelivery,
  HookEvent,
  HookEventDoc,
  HookRule,
  TestHookResponse,
} from '@/lib/api/types'

/**
 * Read a string out of an action config.
 *
 * `config` is `Record<string, unknown>` because its shape depends on the
 * action. `String(unknown)` would render an object as "[object Object]" and put
 * that in an input box, so anything that is not already a string becomes empty.
 */
function configString(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key]
  return typeof value === 'string' ? value : ''
}

export function HooksPanel() {
  const rules = useQuery(hookRulesQuery())
  const deliveries = useQuery(hookDeliveriesQuery())
  const [adding, setAdding] = useState(false)

  const events = rules.data?.events ?? []
  const smtpConfigured = rules.data?.smtp_configured ?? false

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Alert rules</CardTitle>
          <CardDescription>
            Fire a webhook or an email when something happens. Rules are evaluated against what
            the API would show you — the operator&apos;s ground position is stripped from a hook
            payload exactly as it is from the map when that is turned off.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rules.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              {rules.data && rules.data.rules.length === 0 && !adding ? (
                <EmptyState title="No rules yet">
                  Nothing is being alerted on. Add a rule to change that.
                </EmptyState>
              ) : null}

              {rules.data?.rules.map((rule) => (
                <RuleCard
                  key={rule.rule_id}
                  rule={rule}
                  events={events}
                  smtpConfigured={smtpConfigured}
                />
              ))}

              {adding ? (
                <RuleEditor
                  events={events}
                  smtpConfigured={smtpConfigured}
                  onDone={() => setAdding(false)}
                />
              ) : (
                <Button variant="outline" onClick={() => setAdding(true)}>
                  <PlusIcon className="size-4" aria-hidden />
                  Add a rule
                </Button>
              )}
            </>
          )}

          {/* The SSRF gate, which was reachable only through the API.
              
              It is on this card rather than a settings page because it is a
              property of hooks and of nothing else: the check refuses a target
              that RESOLVES to a private address, which is why an admin who can
              point a hook at 169.254.169.254 can read a cloud metadata service
              through it. Somebody turning it on should be looking at the rules
              it applies to. */}
          <div className="border-border/60 border-t pt-3">
            <SettingsGroup
              fields={[
                {
                  key: 'hooks.allow_private_targets',
                  label: 'Allow hooks to reach private addresses',
                  kind: 'switch',
                  hint: 'Needed for a webhook on your own LAN — Home Assistant, a local relay. Off by default because it is also what stops one reaching a cloud metadata service.',
                },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent deliveries</CardTitle>
          <CardDescription>
            Including the ones a cooldown suppressed. &ldquo;Why did I not get an alert&rdquo;
            is a question this is here to answer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {deliveries.data && deliveries.data.dropped > 0 ? (
            <Alert tone="warn" title="Some events were dropped" className="mb-3">
              {deliveries.data.dropped} event
              {deliveries.data.dropped === 1 ? ' was' : 's were'} discarded because the dispatch
              queue was full. That happens when an action is much slower than events arrive —
              check whether a webhook target is timing out.
            </Alert>
          ) : null}

          {deliveries.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : deliveries.data && deliveries.data.deliveries.length > 0 ? (
            <ul className="divide-border/60 divide-y">
              {deliveries.data.deliveries.map((d) => (
                <DeliveryRow key={d.delivery_id} delivery={d} />
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing has fired yet" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RuleCard({
  rule,
  events,
  smtpConfigured,
}: {
  rule: HookRule
  events: HookEventDoc[]
  smtpConfigured: boolean
}) {
  const queryClient = useQueryClient()
  const format = useFormat()
  const [editing, setEditing] = useState(false)
  const [testResult, setTestResult] = useState<TestHookResponse | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.hookRules })

  const toggle = useMutation({
    mutationFn: () => api.updateHookRule(rule.rule_id, { ...rule, enabled: !rule.enabled }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: () => api.deleteHookRule(rule.rule_id),
    onSuccess: invalidate,
  })
  const test = useMutation({
    mutationFn: () => api.testHookRule(rule.rule_id),
    onSuccess: setTestResult,
  })

  if (editing) {
    return (
      <RuleEditor
        rule={rule}
        events={events}
        smtpConfigured={smtpConfigured}
        onDone={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="border-border/60 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium">{rule.name}</span>
        <Badge variant="outline">{rule.event}</Badge>
        <Badge variant="muted">{rule.action}</Badge>
        {!rule.enabled ? <Badge variant="down">disabled</Badge> : null}

        <div className="ml-auto flex items-center gap-2">
          <Switch
            checked={rule.enabled}
            onCheckedChange={() => toggle.mutate()}
            aria-label={`Enable ${rule.name}`}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => test.mutate()}
            disabled={test.isPending}
          >
            <PlayIcon className="size-3.5" aria-hidden />
            {test.isPending ? 'Sending…' : 'Test'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <Trash2Icon className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground mt-1.5 text-2xs">
        {/* Spelled out, because "5 minute cooldown" reads as "one alert per five
            minutes" and it is not — a second aircraft alerts immediately. */}
        One alert per {rule.event.startsWith('track') ? 'aircraft' : 'subject'} every{' '}
        {Math.round(rule.cooldown_s / 60) || 1} min
        {rule.only_drones ? ' · manned ADS-B traffic excluded' : ''}
        {rule.min_confidence ? ` · confidence ≥ ${rule.min_confidence}` : ''}
        {rule.fire_count > 0 && rule.last_fired_at
          ? ` · fired ${rule.fire_count}×, last ${format.timestamp(rule.last_fired_at)}`
          : ' · never fired'}
      </p>

      {testResult ? (
        <Alert
          tone={testResult.delivered ? 'ok' : 'error'}
          title={testResult.delivered ? 'Test delivered' : 'Test failed'}
          className="mt-2"
        >
          {testResult.delivered
            ? `The target accepted it${testResult.response_code ? ` (${testResult.response_code})` : ''}.`
            : testResult.error}
        </Alert>
      ) : null}
    </div>
  )
}

const ACTION_OPTIONS: { value: HookAction; label: string }[] = [
  { value: 'webhook', label: 'Webhook — POST JSON to a URL' },
  { value: 'email', label: 'Email' },
]

function RuleEditor({
  rule,
  events,
  smtpConfigured,
  onDone,
}: {
  rule?: HookRule
  events: HookEventDoc[]
  smtpConfigured: boolean
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(rule?.name ?? '')
  const [event, setEvent] = useState<HookEvent>(rule?.event ?? 'track.confirmed')
  const [action, setAction] = useState<HookAction>(rule?.action ?? 'webhook')
  const [cooldownMin, setCooldownMin] = useState(Math.round((rule?.cooldown_s ?? 300) / 60))
  const [onlyDrones, setOnlyDrones] = useState(rule?.only_drones ?? true)
  const [minConfidence, setMinConfidence] = useState(rule?.min_confidence ?? 0)
  const [url, setUrl] = useState(configString(rule?.config, 'url'))
  // Initialised from the server's value, which for a set secret is the
  // placeholder. Left untouched, it is sent back as-is and the server reads
  // that as "unchanged" — so editing the name does not wipe the token.
  const [authorization, setAuthorization] = useState(
    configString(rule?.config, 'authorization'),
  )
  const [to, setTo] = useState(configString(rule?.config, 'to'))
  const [subject, setSubject] = useState(configString(rule?.config, 'subject'))

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> =
        action === 'webhook'
          ? { url, ...(authorization ? { authorization } : {}) }
          : { to, ...(subject ? { subject } : {}) }
      const body: Partial<HookRule> = {
        name,
        event,
        action,
        enabled: rule?.enabled ?? true,
        cooldown_s: Math.max(1, cooldownMin) * 60,
        only_drones: onlyDrones,
        min_confidence: minConfidence || undefined,
        config,
      }
      return rule ? api.updateHookRule(rule.rule_id, body) : api.createHookRule(body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.hookRules })
      onDone()
    },
  })
  const error = save.error instanceof ApiError ? save.error : null

  const doc = events.find((e) => e.event === event)?.description

  return (
    <form
      className="border-border/60 space-y-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      {error ? (
        <Alert tone="error" title="Could not save the rule">
          {error.message}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name">
          {(props) => (
            <Input {...props} value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </FormField>
        <FormField label="When">
          {(props) => (
            <Select
              {...props}
              aria-label="Event"
              value={event}
              onValueChange={setEvent}
              options={events.map((e) => ({ value: e.event, label: e.event }))}
            />
          )}
        </FormField>
      </div>

      {doc ? <p className="text-muted-foreground text-2xs leading-relaxed">{doc}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Cooldown (minutes)"
          hint="per aircraft or sensor, not per rule — a second drone still alerts immediately"
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              value={cooldownMin}
              onChange={(e) => setCooldownMin(Number(e.target.value))}
            />
          )}
        </FormField>
        <FormField label="Minimum confidence" hint="0 for no filter">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minConfidence}
              onChange={(e) => setMinConfidence(Number(e.target.value))}
            />
          )}
        </FormField>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <Switch
          checked={onlyDrones}
          onCheckedChange={setOnlyDrones}
          aria-label="Exclude manned ADS-B traffic"
        />
        <span>
          Exclude manned ADS-B traffic — most of what this box sees, and almost never what an
          alert is for
        </span>
      </div>

      <FormField label="Do what">
        {(props) => (
          <Select
            {...props}
            aria-label="Action"
            value={action}
            onValueChange={setAction}
            options={ACTION_OPTIONS}
          />
        )}
      </FormField>

      {action === 'webhook' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="URL">
            {(props) => (
              <Input {...props} value={url} onChange={(e) => setUrl(e.target.value)} />
            )}
          </FormField>
          <FormField
            label="Authorization header"
            hint={
              authorization === SECRET_PLACEHOLDER
                ? 'a value is set; leave as-is to keep it'
                : 'optional'
            }
          >
            {(props) => (
              <Input
                {...props}
                value={authorization}
                onChange={(e) => setAuthorization(e.target.value)}
              />
            )}
          </FormField>
        </div>
      ) : (
        <>
          {!smtpConfigured ? (
            <Alert tone="warn" title="No mail server is configured on this unit">
              Set <code className="font-mono text-xs">CLASSG_SMTP_HOST</code> and{' '}
              <code className="font-mono text-xs">CLASSG_SMTP_FROM</code>. An email rule saved
              now will fail when it fires.
            </Alert>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="To" hint="comma separated">
              {(props) => (
                <Input {...props} value={to} onChange={(e) => setTo(e.target.value)} />
              )}
            </FormField>
            <FormField label="Subject" hint="optional">
              {(props) => (
                <Input
                  {...props}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              )}
            </FormField>
          </div>
        </>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending || !name}>
          {save.isPending ? 'Saving…' : rule ? 'Save' : 'Create'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function DeliveryRow({ delivery }: { delivery: HookDelivery }) {
  const format = useFormat()
  const tone =
    delivery.status === 'delivered'
      ? 'ok'
      : delivery.status === 'failed'
        ? 'down'
        : delivery.status === 'suppressed'
          ? 'muted'
          : 'warn'

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
      <Badge variant={tone}>{delivery.status}</Badge>
      <span className="font-medium">{delivery.rule_name ?? delivery.rule_id}</span>
      <span className="text-muted-foreground">{delivery.event}</span>
      {delivery.error ? (
        <span className="text-down truncate" title={delivery.error}>
          {delivery.error}
        </span>
      ) : null}
      {delivery.attempts > 1 ? (
        <span className="text-muted-foreground">{delivery.attempts} attempts</span>
      ) : null}
      <span className="text-muted-foreground ml-auto">
        {format.timestamp(delivery.created_at)}
      </span>
    </li>
  )
}

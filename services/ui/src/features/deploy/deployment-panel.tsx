/**
 * What this unit is running, and a way to ask for an update.
 *
 * The honesty this panel exists to preserve: **the API cannot deploy anything.**
 * It writes a request marker that the host-side agent picks up on its own
 * schedule. So the button says "Request deploy", the confirmation says the
 * agent acts within ten minutes, and there is no spinner implying work is
 * happening right now. A UI that showed "Deploying…" for ten minutes would be
 * lying about where the work is.
 *
 * `state_age_s` is displayed as prominently as the timer flag, because it is
 * worth more: a large age means the agent is not actually running, whatever
 * `timer_enabled` claims.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2Icon, CircleDashedIcon, RocketIcon, XCircleIcon } from 'lucide-react'

import { useFormat } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, DataList, DataRow, Skeleton } from '@/components/ui/misc'
import { ApiError, api } from '@/lib/api/client'
import { deploymentQuery, queryKeys } from '@/lib/api/queries'
import type { DeploymentStatus } from '@/lib/api/types'

import { ArtefactList } from './artefact-list'
import { LogDisclosure } from './log-disclosure'

/** Past this, the agent is not running whatever the timer flag says. The timer
 *  fires every ten minutes, so three times that is unambiguous. */
const STALE_AFTER_S = 30 * 60

export function DeploymentPanel() {
  const queryClient = useQueryClient()
  const format = useFormat()
  const status = useQuery(deploymentQuery())

  const deploy = useMutation({
    mutationFn: () => api.requestDeploy(),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.deployment, next)
    },
  })
  const cancel = useMutation({
    mutationFn: () => api.cancelDeploy(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.deployment }),
  })
  const error = deploy.error instanceof ApiError ? deploy.error : null

  if (status.isPending) return <Skeleton className="h-48 w-full" />

  const d = status.data
  if (!d) return null

  if (!d.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Deployment</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert tone="info" title="No deploy agent on this unit">
            {d.reason ?? 'Not configured.'}
          </Alert>
        </CardContent>
      </Card>
    )
  }

  const stale = d.state_age_s !== undefined && d.state_age_s > STALE_AFTER_S
  const deploying = d.last_result === 'deploying'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Deployment
          {/* In flight beats every other badge: it is the only one that says
              something is happening right now, and it makes both of the others
              moot for as long as it is true. */}
          {deploying ? (
            <Badge variant="warn" className="gap-1.5">
              <span className="bg-warn size-1.5 animate-pulse rounded-full" aria-hidden />
              deploying
            </Badge>
          ) : (
            <>
              {d.update_available ? <Badge variant="warn">update available</Badge> : null}
              {d.deploy_requested ? <Badge variant="warn">deploy queued</Badge> : null}
            </>
          )}
        </CardTitle>
        <CardDescription>
          This unit pulls from <code className="font-mono text-xs">main</code> and deploys only
          a commit whose CI passed. The API itself cannot deploy — it asks the host agent, which
          acts on its own schedule.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {deploying ? (
          <Alert tone="info" title="A deploy is running on the unit now">
            The rebuild takes several minutes on a Pi. Detection continues until each service is
            restarted; the log below updates as it goes.
          </Alert>
        ) : null}

        {stale && !deploying ? (
          <Alert tone="warn" title="The deploy agent has not checked in recently">
            Last check {format.timestamp(d.last_check_at ?? '')} — {formatAge(d.state_age_s)}{' '}
            ago. The timer is probably not running. On the unit:{' '}
            <code className="font-mono text-xs">systemctl status classg-autodeploy.timer</code>
          </Alert>
        ) : null}

        {error ? (
          <Alert tone="error" title="Could not request a deploy">
            {error.message}
          </Alert>
        ) : null}

        <DataList>
          <DataRow
            label="Running"
            value={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{(d.commit ?? '').slice(0, 8) || 'unknown'}</span>
                {d.commit_subject ? (
                  <span className="text-muted-foreground">{d.commit_subject}</span>
                ) : null}
              </span>
            }
          />
          <DataRow
            label="Latest on main"
            value={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">
                  {(d.remote_commit ?? '').slice(0, 8) || 'unknown'}
                </span>
                {/* Only when there is something to deploy. CI gates a deploy;
                    on a unit already running that commit the badge answers a
                    question nobody asked, and "not checked" beside a commit
                    that is demonstrably running reads as a warning. */}
                {d.update_available ? <CiBadge ci={d.remote_ci} /> : null}
              </span>
            }
          />
          <DataRow
            label="Last check"
            value={hasRealDate(d.last_check_at) ? format.timestamp(d.last_check_at) : 'never'}
            hint={d.state_age_s !== undefined ? `${formatAge(d.state_age_s)} ago` : undefined}
          />
          <DataRow
            label="Last result"
            value={d.last_result ?? 'unknown'}
            hint={d.last_reason ?? undefined}
          />
          <DataRow
            label="Last deploy"
            value={
              // hasRealDate, not a truthiness check. The API used to send
              // "0001-01-01T00:00:00Z" for a unit that had never deployed --
              // Go's omitempty does nothing on a time.Time -- and a bare
              // `d.last_deploy_at ?` read that as real, rendering "Dec 31, 1"
              // beside a "rolled back" badge for a deploy that never ran.
              // The API sends null now; this is the second line, because a
              // date formatter should never be handed a value on trust.
              hasRealDate(d.last_deploy_at) ? (
                <span className="flex flex-wrap items-center gap-2">
                  {format.timestamp(d.last_deploy_at)}
                  {d.last_deploy_ok ? (
                    <Badge variant="ok">ok</Badge>
                  ) : (
                    <Badge variant="down">rolled back</Badge>
                  )}
                </span>
              ) : (
                'never'
              )
            }
          />
          <DataRow
            label="Automatic deploys"
            value={
              d.timer_enabled ? (
                <Badge variant="ok">on</Badge>
              ) : (
                <Badge variant="muted">off</Badge>
              )
            }
          />
        </DataList>

        <div className="flex flex-wrap items-center gap-2">
          {d.deploy_requested ? (
            <>
              <Button
                variant="outline"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                Withdraw request
              </Button>
              <span className="text-muted-foreground text-2xs">
                Queued. The agent picks this up within ten minutes and still refuses if CI is
                not green or a capture or sweep is running.
              </span>
            </>
          ) : (
            <>
              <Button onClick={() => deploy.mutate()} disabled={deploy.isPending}>
                <RocketIcon className="size-4" aria-hidden />
                Request deploy
              </Button>
              <span className="text-muted-foreground text-2xs">
                Queues a deploy for the agent&apos;s next check — not immediate. Detection stops
                while the unit rebuilds.
              </span>
            </>
          )}
        </div>

        <ArtefactList artefacts={d.artefacts} label="Locally built, at the last check" />

        <LogDisclosure
          log={d.log}
          summary={`Last agent run (${d.log?.length ?? 0} line${d.log?.length === 1 ? '' : 's'})`}
        />
      </CardContent>
    </Card>
  )
}

function CiBadge({ ci }: { ci: DeploymentStatus['remote_ci'] }) {
  if (ci === 'success') {
    return (
      <Badge variant="ok">
        <CheckCircle2Icon className="size-3" aria-hidden />
        CI green
      </Badge>
    )
  }
  if (ci === 'failure') {
    return (
      <Badge variant="down">
        <XCircleIcon className="size-3" aria-hidden />
        CI failed
      </Badge>
    )
  }
  if (ci === 'pending') {
    return (
      <Badge variant="warn">
        <CircleDashedIcon className="size-3" aria-hidden />
        CI running
      </Badge>
    )
  }
  // "unknown" is the honest answer when the agent had no reason to check --
  // the unit was already up to date, so it never asked GitHub.
  return <Badge variant="muted">CI not checked</Badge>
}

/**
 * Whether a timestamp is a real one.
 *
 * Guards against the year-1 zero time and anything unparseable. A date
 * formatter handed "0001-01-01T00:00:00Z" renders it happily, which is how a
 * unit that had never deployed came to report one on 31 December, year 1.
 */
function hasRealDate(iso: string | undefined): iso is string {
  if (!iso) return false
  const at = Date.parse(iso)
  // 1971 rather than 1970: anything at or below the epoch is a sentinel, not a
  // deploy someone did.
  return Number.isFinite(at) && at > Date.parse('1971-01-01T00:00:00Z')
}

function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) return 'unknown'
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}

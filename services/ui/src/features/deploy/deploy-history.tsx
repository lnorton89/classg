/**
 * Past deploys, newest first, each opening to the log it produced.
 *
 * The gap this fills: the agent kept exactly one run's log, overwritten every
 * ten minutes by the next timer firing. A deploy that broke something was
 * therefore unreadable within minutes of breaking it, on a unit with no shell
 * access — which is precisely when the log is worth having.
 *
 * Only runs that did something are listed. A timer that fires every ten
 * minutes and finds nothing to do would bury a week's six real deploys under a
 * thousand rows of "up to date", and the whole point of a list is finding the
 * one that matters.
 */
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2Icon, HammerIcon, HistoryIcon, XCircleIcon } from 'lucide-react'

import { useFormat } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, EmptyState, Skeleton } from '@/components/ui/misc'
import { deploymentHistoryQuery } from '@/lib/api/queries'
import type { DeploymentRun } from '@/lib/api/types'

import { ArtefactList } from './artefact-list'

// Keyed by `string`, not by the result union, on purpose. The type says the
// agent only ever sends these three; the agent is a shell script on a box that
// upgrades independently of this bundle, and a future result it learns to write
// would otherwise render as an undefined icon and throw. Widening the key makes
// the fallback below something TypeScript agrees is reachable.
const RESULTS: Record<
  string,
  {
    label: string
    tone: 'ok' | 'down' | 'warn'
    icon: typeof CheckCircle2Icon
    iconClass: string
  }
> = {
  deployed: { label: 'deployed', tone: 'ok', icon: CheckCircle2Icon, iconClass: 'text-ok' },
  failed: { label: 'failed', tone: 'down', icon: XCircleIcon, iconClass: 'text-down' },
  rebuilt: { label: 'rebuilt', tone: 'warn', icon: HammerIcon, iconClass: 'text-warn' },
}

/** Seconds as a person would say them. Deploys on a Pi run to minutes. */
function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${String(Math.round(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`
}

export function DeployHistory() {
  const history = useQuery(deploymentHistoryQuery())

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HistoryIcon className="size-4" aria-hidden />
          Deploy history
        </CardTitle>
        <CardDescription>
          Every run that did something — deployed, rolled back, or rebuilt a stale artefact.
          Checks that found nothing to do are not listed.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {history.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : history.data && !history.data.configured ? (
          <Alert tone="info" title="No deploy agent on this unit">
            {history.data.reason}
          </Alert>
        ) : (history.data?.runs.length ?? 0) === 0 ? (
          <EmptyState icon={HistoryIcon} title="Nothing recorded yet">
            The first deploy, rollback or artefact rebuild after the agent gained a history
            appears here.
          </EmptyState>
        ) : (
          <ul className="divide-border/60 divide-y">
            {(history.data?.runs ?? []).map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function RunRow({ run }: { run: DeploymentRun }) {
  const format = useFormat()
  const result = RESULTS[run.result] ?? {
    label: run.result,
    tone: 'warn' as const,
    icon: HammerIcon,
    iconClass: 'text-warn',
  }
  const Icon = result.icon
  const took = duration(run.duration_s)

  return (
    <li>
      <details className="group">
        <summary
          className={[
            'flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-2.5',
            'hover:bg-muted/30 -mx-2 rounded-md px-2',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          ].join(' ')}
        >
          {/* A literal class off the table, never `text-${tone}`: Tailwind
              scans source text for whole class names and generates no CSS for
              a name that only exists once the template is evaluated. */}
          <Icon className={`size-4 shrink-0 ${result.iconClass}`} aria-hidden />
          <Badge variant={result.tone}>{result.label}</Badge>
          {run.commit ? (
            <code className="font-mono text-xs">{run.commit.slice(0, 8)}</code>
          ) : null}
          {/* The subject wraps and takes the remaining width; on a phone it
              becomes its own line rather than truncating to nothing useful. */}
          <span className="min-w-0 flex-1 basis-full text-xs sm:basis-auto">
            {run.commit_subject}
          </span>
          <span className="text-muted-foreground tnum shrink-0 text-2xs">
            {format.relative(run.finished_at)}
            {took ? ` · ${took}` : ''}
          </span>
        </summary>

        <div className="space-y-2 pb-3 pl-6">
          {run.reason ? (
            <p className="text-muted-foreground text-xs leading-relaxed">{run.reason}</p>
          ) : null}

          {run.previous_commit && run.commit && run.previous_commit !== run.commit ? (
            <p className="text-muted-foreground font-mono text-2xs">
              {run.previous_commit.slice(0, 8)} → {run.commit.slice(0, 8)}
            </p>
          ) : null}

          <ArtefactList artefacts={run.artefacts} />

          {run.log && run.log.length > 0 ? (
            <pre className="bg-muted/40 max-h-72 overflow-auto rounded-md p-2 font-mono text-2xs whitespace-pre-wrap">
              {run.log.join('\n')}
            </pre>
          ) : (
            <p className="text-muted-foreground text-2xs">No log was recorded for this run.</p>
          )}
        </div>
      </details>
    </li>
  )
}

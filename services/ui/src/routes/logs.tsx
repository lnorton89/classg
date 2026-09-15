import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ScrollTextIcon } from 'lucide-react'
import { useMemo } from 'react'
import { z } from 'zod'

import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { Why } from '@/components/ui/why'
import { LOG_SOURCES, type LogSource } from '@/features/logs/log-store'
import { LogsView } from '@/features/logs/logs-view'

/**
 * What was narrowed to, in the URL.
 *
 * This is the screen someone narrows because they are reconstructing a
 * specific four minutes, and every one of those three controls was component
 * state: opening a track from a log row and pressing Back put the whole log
 * back, unfiltered, at info level. Same convention as routes/sensors.tsx and
 * routes/tracks/index.tsx — every key optional, every key `.catch(undefined)`
 * so a stale or hand-edited URL degrades to the default view rather than
 * throwing, and absent rather than empty when unset.
 *
 * `source` is a comma-separated list because the chips are a multi-select and
 * always have been; one key holding several values keeps the URL readable and
 * keeps the control honest.
 */
export const logsSearchSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional().catch(undefined),
  source: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
})

export type LogsSearch = z.infer<typeof logsSearchSchema>

/**
 * Unknown names are dropped rather than rejected: a link from a build that had
 * a source this one does not must still open the log.
 *
 * An absent, empty or all-unknown value means every source, which is both the
 * default and the only safe reading: a selection nothing matches would render
 * an empty log, and an empty log looks like a fault rather than like a filter.
 */
export function parseLogSources(value: string | undefined): Set<LogSource> {
  if (value === undefined) return new Set(LOG_SOURCES)
  const known = value
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is LogSource => (LOG_SOURCES as string[]).includes(name))
  return known.length > 0 ? new Set(known) : new Set(LOG_SOURCES)
}

/** Absent when every source is on, so the default does not litter the URL. */
export function formatLogSources(sources: Set<LogSource>): string | undefined {
  if (sources.size === LOG_SOURCES.length) return undefined
  return LOG_SOURCES.filter((source) => sources.has(source)).join(',')
}

export const Route = createFileRoute('/logs')({
  component: LogsRoute,
  validateSearch: logsSearchSchema,
})

function LogsRoute() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // replace: true -- narrowing a log is not a new page to walk back through.
  // Back should leave the page, and land on the view it was left in.
  function setSearch(patch: Partial<LogsSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

  const sources = useMemo(() => parseLogSources(search.source), [search.source])

  return (
    <PageContainer className="min-h-0 flex-1">
      <PageHeader
        icon={ScrollTextIcon}
        title="Event log"
        description={
          <>
            Everything this console has observed since the page was opened, in the order it
            happened.{' '}
            {/* The enumeration and the caveat are both worth having and neither
                is worth a paragraph above the log on every visit. */}
            <Why
              label="What counts as an event, and is this the system's log?"
              className="mt-1.5"
            >
              Stream connects and drops, track lifecycle, sensor health transitions, captures,
              API failures and your own actions — transitions only, never the 1 Hz frame stream.
              It is a record of what this <em>browser</em> saw: it is bounded, it is lost when
              the tab closes, and it is explicitly not the system&rsquo;s log. The sensors and
              the API keep their own on the Pi, and those are the forensic record.
            </Why>
          </>
        }
      />
      <LogsView
        minLevel={search.level ?? 'info'}
        onMinLevelChange={(level) => setSearch({ level: level === 'info' ? undefined : level })}
        sources={sources}
        onSourcesChange={(next) => setSearch({ source: formatLogSources(next) })}
        search={search.q ?? ''}
        onSearchChange={(q) => setSearch({ q: q === '' ? undefined : q })}
      />
    </PageContainer>
  )
}

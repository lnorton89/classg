/**
 * The event log view.
 *
 * Built for two different readings. Scanning — "is anything wrong right now" —
 * is served by the level counters and the colour-coded rail down the left edge.
 * Reconstructing — "what happened between 02:10 and 02:14" — is served by
 * filters, search, and an export that can be attached to a report.
 *
 * Following is on by default but suspends the moment you scroll away from the
 * bottom. Yanking an operator back to the tail while they are reading three
 * entries up is the fastest way to make a log useless.
 */
import { Link } from '@tanstack/react-router'
import {
  ArrowDownToLineIcon,
  DownloadIcon,
  FileTextIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { useFormat } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { EmptyState } from '@/components/ui/misc'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'

import {
  LEVEL_RANK,
  LOG_SOURCES,
  downloadText,
  logStore,
  toCsv,
  toNdjson,
  type LogEntry,
  type LogLevel,
  type LogSource,
} from './log-store'

/**
 * Rendering every buffered entry would put 1000 DOM nodes on a Pi's browser for
 * scrollback nobody is looking at. The cap is generous enough that the notice
 * almost never appears, and the export always covers the full buffer.
 */
const RENDER_CAP = 400

const LEVEL_STYLE: Record<LogLevel, { chip: string; rail: string; label: string }> = {
  debug: { chip: 'bg-muted text-muted-foreground', rail: 'bg-border', label: 'DEBUG' },
  info: { chip: 'bg-primary/15 text-primary', rail: 'bg-primary/50', label: 'INFO' },
  warn: { chip: 'bg-warn/15 text-warn', rail: 'bg-warn', label: 'WARN' },
  error: { chip: 'bg-down/15 text-down', rail: 'bg-down', label: 'ERROR' },
}

const SOURCE_LABEL: Record<LogSource, string> = {
  stream: 'stream',
  track: 'track',
  detection: 'detection',
  sensor: 'sensor',
  capture: 'capture',
  spectrum: 'spectrum',
  deploy: 'deploy',
  api: 'api',
  ui: 'operator',
}

const MIN_LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  // "Everything", matching Settings › Notifications' severity control -- and
  // because "All" left the Debug counter tile pointing at no visible filter.
  { value: 'debug', label: 'Everything' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
]

function useLogEntries(): LogEntry[] {
  return useSyncExternalStore(logStore.subscribe, logStore.getSnapshot, logStore.getSnapshot)
}

export function LogsView() {
  const { preferences, setPreference } = usePreferences()
  const format = useFormat()
  const live = useLogEntries()

  const [minLevel, setMinLevel] = useState<LogLevel>('info')
  const [sources, setSources] = useState<Set<LogSource>>(() => new Set(LOG_SOURCES))
  const [search, setSearch] = useState('')
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const follow = preferences.logFollow

  useEffect(() => {
    logStore.setLimit(preferences.logLimit)
  }, [preferences.logLimit])

  const entries = frozen ?? live

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries.filter((entry) => {
      if (LEVEL_RANK[entry.level] < LEVEL_RANK[minLevel]) return false
      if (!sources.has(entry.source)) return false
      if (!needle) return true
      // Search the detail too: "reason=adapter vanished" is exactly the kind of
      // thing being looked for, and it never appears in the message itself.
      const haystack = `${entry.message} ${entry.source} ${entry.trackId ?? ''} ${
        entry.detail ? JSON.stringify(entry.detail) : ''
      }`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [entries, minLevel, sources, search])

  const visible = filtered.length > RENDER_CAP ? filtered.slice(-RENDER_CAP) : filtered

  const counts = useMemo(() => {
    const tally = { debug: 0, info: 0, warn: 0, error: 0 }
    for (const entry of entries) tally[entry.level] += 1
    return tally
  }, [entries])

  // Follow the tail. Skipped while frozen, which is the whole point of freezing.
  // Keyed on the last entry's id, not the list length: once the render cap is
  // reached the length pins at RENDER_CAP while entries keep arriving, and a
  // follow keyed on length stops firing exactly when the log is busiest.
  const tailId = visible.at(-1)?.id
  useEffect(() => {
    if (!follow || frozen) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [tailId, follow, frozen])

  const onScroll = useCallback(() => {
    const node = scrollRef.current
    if (!node || frozen) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
    if (atBottom !== follow) setPreference('logFollow', atBottom)
  }, [follow, frozen, setPreference])

  const toggleSource = (source: LogSource) => {
    setSources((old) => {
      const next = new Set(old)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      // An empty selection shows nothing, which reads as a broken log rather
      // than as a filter. Turning the last one off restores all of them.
      return next.size === 0 ? new Set(LOG_SOURCES) : next
    })
  }

  const exportEntries = (kind: 'ndjson' | 'csv') => {
    const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
    if (kind === 'ndjson') {
      downloadText(`classg-log-${stamp}.ndjson`, 'application/x-ndjson', toNdjson(filtered))
    } else {
      downloadText(`classg-log-${stamp}.csv`, 'text/csv', toCsv(filtered))
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* The tiles are the filter, not decoration beside it: each one sets the
          severity floor it counts. Debug's tile used to show a number with no
          tab that reached it. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <LevelCount
          label="Errors"
          value={counts.error}
          tone="down"
          active={minLevel === 'error'}
          onClick={() => setMinLevel('error')}
        />
        <LevelCount
          label="Warnings"
          value={counts.warn}
          tone="warn"
          active={minLevel === 'warn'}
          onClick={() => setMinLevel('warn')}
        />
        <LevelCount
          label="Info"
          value={counts.info}
          tone="info"
          active={minLevel === 'info'}
          onClick={() => setMinLevel('info')}
        />
        <LevelCount
          label="Debug"
          value={counts.debug}
          tone="muted"
          active={minLevel === 'debug'}
          onClick={() => setMinLevel('debug')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search messages, track IDs, reasons…"
            aria-label="Search the event log"
            className="pl-8"
          />
        </div>

        <Segmented
          aria-label="Minimum log level"
          value={minLevel}
          onValueChange={setMinLevel}
          options={MIN_LEVEL_OPTIONS}
        />

        <div className="flex items-center gap-1.5">
          <Tooltip
            content={
              frozen
                ? 'Resume: the view is currently frozen; new entries are still being recorded.'
                : 'Freeze the view. Recording continues in the background.'
            }
          >
            <Button
              variant={frozen ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFrozen(frozen ? null : live)}
            >
              {frozen ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
              {frozen ? 'Resume' : 'Freeze'}
            </Button>
          </Tooltip>

          <Tooltip content="Jump to the newest entry and keep following it.">
            <Button
              variant="outline"
              size="sm"
              aria-pressed={follow}
              onClick={() => {
                setFrozen(null)
                setPreference('logFollow', true)
                const node = scrollRef.current
                if (node) node.scrollTop = node.scrollHeight
              }}
            >
              <ArrowDownToLineIcon aria-hidden />
              <span className="hidden sm:inline">{follow ? 'Following' : 'Follow'}</span>
            </Button>
          </Tooltip>

          <Button variant="outline" size="sm" onClick={() => exportEntries('ndjson')}>
            <DownloadIcon aria-hidden />
            <span className="hidden sm:inline">NDJSON</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportEntries('csv')}>
            <FileTextIcon aria-hidden />
            <span className="hidden sm:inline">CSV</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              logStore.clear()
              setFrozen(null)
            }}
          >
            <Trash2Icon aria-hidden />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="label-caps mr-1">Sources</span>
        {LOG_SOURCES.map((source) => {
          const active = sources.has(source)
          return (
            <button
              key={source}
              type="button"
              aria-pressed={active}
              onClick={() => toggleSource(source)}
              className={cn(
                'rounded-md border px-2 py-0.5 text-2xs font-medium transition-colors',
                active
                  ? 'border-primary/40 bg-primary/12 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {SOURCE_LABEL[source]}
            </button>
          )
        })}
        {sources.size < LOG_SOURCES.length ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => setSources(new Set(LOG_SOURCES))}
          >
            <XIcon aria-hidden /> Reset
          </Button>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="border-border bg-card min-h-0 flex-1 overflow-y-auto rounded-lg border"
        // A log is a list of updates; polite so it does not interrupt, and
        // scoped to the container so only new rows are announced.
        aria-live="polite"
        aria-relevant="additions"
        role="log"
        aria-label="Session event log"
      >
        {visible.length === 0 ? (
          <EmptyState
            icon={FileTextIcon}
            title={entries.length === 0 ? 'Nothing logged yet' : 'No entries match the filter'}
          >
            {entries.length === 0
              ? 'Stream connects, track lifecycle, sensor health changes and your own actions appear here as they happen.'
              : 'Widen the level, re-enable a source, or clear the search box.'}
          </EmptyState>
        ) : (
          <ol className="divide-border divide-y">
            {filtered.length > visible.length ? (
              <li className="text-muted-foreground bg-muted/30 px-3 py-1.5 text-2xs">
                Showing the most recent {visible.length} of {filtered.length} matching entries.
                Export includes all of them.
              </li>
            ) : null}
            {visible.map((entry) => (
              <LogRow key={entry.id} entry={entry} clock={format.clock} />
            ))}
          </ol>
        )}
      </div>

      <p className="text-muted-foreground text-2xs">
        {entries.length.toLocaleString()} entries buffered (limit{' '}
        {preferences.logLimit.toLocaleString()})
        {logStore.getDropped() > 0
          ? ` · ${logStore.getDropped().toLocaleString()} older entries dropped`
          : ''}
        . This log covers this browser session only — the sensors and the API keep their own
        logs on the Pi, and those are the record for anything forensic.
      </p>
    </div>
  )
}

function LevelCount({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number
  tone: 'down' | 'warn' | 'info' | 'muted'
  /** This tile's severity floor is the one currently applied. */
  active: boolean
  onClick: () => void
}) {
  const toneClass = {
    down: value > 0 ? 'border-down/45 text-down' : 'border-border text-muted-foreground',
    warn: value > 0 ? 'border-warn/45 text-warn' : 'border-border text-muted-foreground',
    info: 'border-border text-foreground',
    muted: 'border-border text-muted-foreground',
  }[tone]

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Show ${label.toLowerCase()} and above`}
      className={cn(
        'bg-card flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left',
        'hover:bg-accent/40 focus-visible:ring-ring transition-colors focus-visible:ring-2 focus-visible:outline-none',
        toneClass,
        active && 'ring-ring ring-1',
      )}
    >
      <span className="label-caps">{label}</span>
      <span className="font-display tnum text-lg leading-none font-bold">
        {value.toLocaleString()}
      </span>
    </button>
  )
}

function LogRow({ entry, clock }: { entry: LogEntry; clock: (iso: string) => string }) {
  const style = LEVEL_STYLE[entry.level]
  const details = Object.entries(entry.detail ?? {}).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  )

  return (
    <li
      className="hover:bg-accent/25 flex gap-0 transition-colors"
      data-log-level={entry.level}
    >
      {/* A colour rail rather than a coloured row: at a glance you see WHERE the
          errors are in the scrollback without the text losing contrast. */}
      <span className={cn('w-1 shrink-0', style.rail)} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2">
        <time
          dateTime={entry.at}
          className="text-muted-foreground shrink-0 font-mono text-2xs"
          title={entry.at}
        >
          {clock(entry.at)}
        </time>
        <Badge
          variant="muted"
          className={cn('shrink-0 px-1 py-0 font-mono text-2xs', style.chip)}
        >
          {style.label}
        </Badge>
        <span className="text-muted-foreground shrink-0 text-2xs">
          {SOURCE_LABEL[entry.source]}
        </span>
        <span className="min-w-0 flex-1 basis-full text-sm leading-snug sm:basis-auto">
          {entry.message}
        </span>
        {entry.trackId ? (
          <Link
            to="/tracks/$trackId"
            params={{ trackId: entry.trackId }}
            className="text-primary shrink-0 text-2xs underline-offset-2 hover:underline"
          >
            open track
          </Link>
        ) : null}
        {details.length > 0 ? (
          <span className="flex basis-full flex-wrap gap-1">
            {details.map(([key, value]) => (
              <span
                key={key}
                className="border-border text-muted-foreground rounded border px-1 font-mono text-2xs"
              >
                {key}={String(value)}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </li>
  )
}

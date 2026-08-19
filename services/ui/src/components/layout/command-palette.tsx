/**
 * Command palette — ⌘K / Ctrl-K.
 *
 * The thing it actually solves is track lookup. Once a session has fifty
 * tracks, finding the one whose serial someone just read out over the radio
 * means: open Tracks, find the filter box, type, click. This is one keystroke
 * and the same typing, from anywhere in the app including the full-screen map.
 *
 * Navigation and quick settings ride along because the list is already there
 * and a palette that only does one thing does not get learned.
 */
import { Dialog } from '@base-ui/react/dialog'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  BellIcon,
  BookOpenIcon,
  ClockIcon,
  CornerDownLeftIcon,
  GaugeIcon,
  HistoryIcon,
  MapIcon,
  MoonIcon,
  RadarIcon,
  RulerIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SunIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { useTheme } from '@/app/theme-context'
import { useHasRole } from '@/features/auth/use-auth'
import { Kbd } from '@/components/ui/kbd'
import { log } from '@/features/logs/log-store'
import type { TracksResponse } from '@/lib/api/types'
import { cn } from '@/lib/cn'

interface Command {
  id: string
  label: string
  hint?: string
  icon: LucideIcon
  group: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            'bg-background/70 fixed inset-0 z-50 backdrop-blur-sm',
            'transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
          )}
        />
        <Dialog.Popup
          className={cn(
            'bg-popover text-popover-foreground border-border fixed z-50 flex flex-col',
            'top-[12vh] left-1/2 w-[min(38rem,calc(100vw-1.5rem))] -translate-x-1/2',
            'overflow-hidden rounded-xl border shadow-2xl',
            'transition-[transform,opacity] duration-150',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
          )}
          aria-label="Command palette"
        >
          {/* The popup unmounts on close, so the search box and the highlighted
              row reset for free — no effect reaching back to clear them. */}
          <PaletteBody inputRef={inputRef} onDone={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PaletteBody({
  inputRef,
  onDone,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  onDone: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { preferences, setPreference } = usePreferences()
  const { preference: theme, setPreference: setTheme } = useTheme()
  const isAdmin = useHasRole('admin')

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * Tracks come from the query cache rather than a fetch: the list view and the
   * live stream have already populated it, and a palette that waits on the
   * network is a palette that feels broken.
   */
  const tracks = useMemo(() => {
    const entries = queryClient.getQueriesData<TracksResponse>({ queryKey: ['tracks', 'list'] })
    const seen = new Map<string, { id: string; label: string; sub: string }>()
    for (const [, data] of entries) {
      for (const track of data?.tracks ?? []) {
        if (seen.has(track.track_id)) continue
        const serial = track.identity?.serial
        const mac = track.identity?.macs?.[0]
        seen.set(track.track_id, {
          id: track.track_id,
          label: serial ?? mac ?? track.track_id,
          sub: [
            track.state.toLowerCase(),
            serial && mac ? mac : null,
            track.identity?.vendor ?? null,
          ]
            .filter(Boolean)
            .join(' · '),
        })
      }
    }
    return [...seen.values()]
  }, [queryClient])

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => void navigate({ to })
    const nav: Command[] = [
      { id: 'nav-live', label: 'Live map', icon: MapIcon, group: 'Go to', run: go('/') },
      {
        id: 'nav-tracks',
        label: 'Tracks',
        icon: RadarIcon,
        group: 'Go to',
        run: go('/tracks'),
      },
      {
        id: 'nav-timeline',
        label: 'Timeline — what happened while you were away',
        icon: HistoryIcon,
        group: 'Go to',
        run: go('/timeline'),
      },
      {
        id: 'nav-sensors',
        label: 'Sensors, spectrum and captures',
        icon: SlidersHorizontalIcon,
        group: 'Go to',
        run: go('/sensors'),
      },
      {
        id: 'nav-logs',
        label: 'Event log',
        icon: ScrollTextIcon,
        group: 'Go to',
        run: go('/logs'),
      },
      { id: 'nav-docs', label: 'Docs', icon: BookOpenIcon, group: 'Go to', run: go('/docs') },
      {
        id: 'nav-settings',
        label: 'Settings — units, time, display',
        icon: SettingsIcon,
        group: 'Go to',
        run: go('/settings'),
      },
      {
        id: 'nav-notifications',
        label: 'Notification settings — what reaches the drawer',
        icon: BellIcon,
        group: 'Go to',
        run: go('/settings/notifications'),
      },
      {
        id: 'nav-calibration',
        label: 'Calibration — channel plan and fusion weights',
        icon: GaugeIcon,
        group: 'Go to',
        run: go('/settings/calibration'),
      },
      // Gated the same way the account menu's link is: offering a viewer a
      // destination that renders "you need the administrator role" is noise.
      ...(isAdmin
        ? [
            {
              id: 'nav-admin',
              label: 'Administration — accounts, hooks, deployment',
              icon: ShieldCheckIcon,
              group: 'Go to',
              run: go('/admin'),
            },
          ]
        : []),
    ]

    const quick: Command[] = [
      {
        id: 'act-theme',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: theme === 'dark' ? SunIcon : MoonIcon,
        group: 'Quick settings',
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'act-units',
        label: `Switch units to ${nextUnits(preferences.units)}`,
        hint: `currently ${preferences.units}`,
        icon: RulerIcon,
        group: 'Quick settings',
        run: () => {
          const next = nextUnits(preferences.units)
          setPreference('units', next)
          log.action(`Units set to ${next}`)
        },
      },
      {
        id: 'act-tz',
        label:
          preferences.timeZone === 'utc' ? 'Show times in local time' : 'Show times in UTC',
        icon: ClockIcon,
        group: 'Quick settings',
        run: () => setPreference('timeZone', preferences.timeZone === 'utc' ? 'local' : 'utc'),
      },
    ]

    const trackCommands: Command[] = tracks.map((track) => ({
      id: `track-${track.id}`,
      label: track.label,
      hint: track.sub,
      icon: RadarIcon,
      group: 'Tracks',
      run: () => void navigate({ to: '/tracks/$trackId', params: { trackId: track.id } }),
    }))

    return [...nav, ...quick, ...trackCommands]
  }, [
    navigate,
    theme,
    setTheme,
    preferences.units,
    preferences.timeZone,
    setPreference,
    tracks,
    isAdmin,
  ])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ''} ${command.group}`.toLowerCase().includes(needle),
    )
  }, [commands, query])

  /*
   * Focus the search box on mount.
   *
   * Neither `autoFocus` nor the dialog's own `initialFocus` lands here: the
   * palette is opened from a global key handler rather than from a Trigger, and
   * Base UI's automatic focus management does not run for that path — focus was
   * observed staying on <body>, so the operator's next keystroke went nowhere.
   */
  useEffect(() => {
    inputRef.current?.focus()
  }, [inputRef])

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const groups = useMemo(() => {
    const map = new Map<string, { command: Command; index: number }[]>()
    filtered.forEach((command, index) => {
      const list = map.get(command.group) ?? []
      list.push({ command, index })
      map.set(command.group, list)
    })
    return [...map.entries()]
  }, [filtered])

  const run = (command: Command) => {
    onDone()
    command.run()
  }

  return (
    <>
      <Dialog.Title className="sr-only">Command palette</Dialog.Title>
      <div className="border-border flex items-center gap-2 border-b px-3">
        <SearchIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        {/* Base UI moves focus to the first tabbable element in the popup, which
            is this input — so no autoFocus is needed or wanted. */}
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            // Resetting here rather than in an effect keeps the highlight in
            // step with the list without a second render pass.
            setActive(0)
          }}
          placeholder="Search tracks, pages and settings…"
          aria-label="Search commands and tracks"
          // A combobox needs its list wired up to be announced correctly.
          role="combobox"
          aria-expanded
          aria-controls="command-palette-list"
          aria-activedescendant={
            filtered[active] ? `command-${filtered[active].id}` : undefined
          }
          className="placeholder:text-muted-foreground h-12 flex-1 bg-transparent text-sm outline-none"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((old) => (filtered.length ? (old + 1) % filtered.length : 0))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((old) =>
                filtered.length ? (old - 1 + filtered.length) % filtered.length : 0,
              )
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const command = filtered[active]
              if (command) run(command)
            }
          }}
        />
        <Kbd>Esc</Kbd>
      </div>

      <div
        ref={listRef}
        id="command-palette-list"
        role="listbox"
        aria-label="Commands"
        className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5"
      >
        {filtered.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-sm">
            Nothing matches “{query}”.
          </p>
        ) : (
          groups.map(([group, items]) => (
            <div key={group} className="mb-1">
              <p className="label-caps px-2 py-1">{group}</p>
              {items.map(({ command, index }) => (
                <button
                  key={command.id}
                  id={`command-${command.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(command)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm',
                    index === active ? 'bg-accent text-accent-foreground' : 'text-foreground',
                  )}
                >
                  <command.icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {group === 'Tracks' ? (
                      <span className="font-mono">{command.label}</span>
                    ) : (
                      command.label
                    )}
                    {command.hint ? (
                      <span className="text-muted-foreground ml-2 text-2xs">
                        {command.hint}
                      </span>
                    ) : null}
                  </span>
                  {index === active ? (
                    <CornerDownLeftIcon
                      className="text-muted-foreground size-3.5 shrink-0"
                      aria-hidden
                    />
                  ) : null}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  )
}

function nextUnits(current: 'metric' | 'imperial' | 'aviation') {
  return current === 'metric' ? 'aviation' : current === 'aviation' ? 'imperial' : 'metric'
}

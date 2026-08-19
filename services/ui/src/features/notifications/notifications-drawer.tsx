import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ActivityIcon,
  AudioWaveformIcon,
  BellIcon,
  CircleAlertIcon,
  HardDriveIcon,
  MousePointerClickIcon,
  PlaneIcon,
  RadioIcon,
  SettingsIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { useFormat, useTicker } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Tooltip } from '@/components/ui/tooltip'
import { logStore } from '@/features/logs/log-store'
import { tracksQuery } from '@/lib/api/queries'
import { cn } from '@/lib/cn'

import {
  buildFeed,
  countUnread,
  NOTIFY_CATEGORY_LABEL,
  type Notification,
  type NotifyCategory,
} from './feed'

/**
 * How many tracks to ask the API for, and how many rows the drawer will render.
 *
 * A count rather than a time window on purpose. A window needs `Date.now()`
 * during render -- impure, and it churns the query key every render -- and
 * "the last hundred things" is a more useful answer anyway: after a quiet week
 * a 12-hour window shows nothing, which reads as a broken drawer.
 */
const TRACK_LIMIT = 100
const RENDER_LIMIT = 200

const CATEGORY_ICON: Record<NotifyCategory, LucideIcon> = {
  drone: PlaneIcon,
  sensor: RadioIcon,
  stream: ActivityIcon,
  capture: HardDriveIcon,
  spectrum: AudioWaveformIcon,
  unit: WrenchIcon,
  api: CircleAlertIcon,
  action: MousePointerClickIcon,
}

/**
 * Recent events worth looking up for: drones in range, and what the console
 * itself saw happen.
 *
 * The map answers "what is up right now"; this answers "what has happened over
 * the last while", which is the question you actually have after being away
 * from the screen. A continuously-recording detector is only useful if you can
 * find out what it caught while you were not looking.
 *
 * "Probable" is deliberate wherever a drone is named. A track is evidence a
 * Remote ID broadcast was received nearby, not proof of an aircraft, so nothing
 * here is phrased as certainty and the confidence is always shown.
 */
export function NotificationsDrawer() {
  const { preferences } = usePreferences()
  const [open, setOpen] = useState(false)
  const [lastSeenAt, setLastSeenAt] = useState<number>(() => readLastSeen())
  const closeRef = useRef<HTMLButtonElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery(
    tracksQuery({
      state: ['CONFIRMED', 'COASTING', 'CLOSED'],
      limit: TRACK_LIMIT,
    }),
  )
  const entries = useSyncExternalStore(
    logStore.subscribe,
    logStore.getSnapshot,
    logStore.getSnapshot,
  )

  const feed = useMemo(
    () =>
      buildFeed({
        tracks: data?.tracks ?? [],
        entries,
        categories: preferences.notifyCategories,
        minLevel: preferences.notifyMinLevel,
        limit: RENDER_LIMIT,
      }),
    [data, entries, preferences.notifyCategories, preferences.notifyMinLevel],
  )

  const unread = countUnread(feed, lastSeenAt)

  // Marking read happens in the click handler, not an effect: it is a
  // consequence of the user opening the drawer, and setting state from an
  // effect just to react to state we already own causes a cascading render.
  function openDrawer() {
    const now = Date.now()
    setLastSeenAt(now)
    writeLastSeen(now)
    setOpen(true)
  }

  // Focus only -- no state -- so the panel is keyboard-usable on open, and
  // handed back to the bell on close so a keyboard user is not dropped on
  // <body> when the panel unmounts under their focus.
  const hadFocus = useRef(false)
  useEffect(() => {
    if (open) {
      hadFocus.current = true
      closeRef.current?.focus()
    } else if (hadFocus.current) {
      hadFocus.current = false
      bellRef.current?.focus()
    }
  }, [open])

  // Escape closes, because a panel that traps you is worse than no panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /*
   * Close on a click outside, without a backdrop element.
   *
   * A full-screen backdrop is what makes a panel modal: it dims the page and
   * swallows the first click, so reaching the map underneath costs two. This is
   * a glanceable list of what just happened -- the map and the sensor pills
   * behind it are exactly what you want to look at next, and they stay lit and
   * clickable. `pointerdown` rather than `click` so the panel is gone before
   * whatever was underneath reacts.
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      // The bell itself toggles; letting this fire too would close and reopen.
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div ref={triggerRef} className="inline-flex">
      <Tooltip content="Recent detections and system events">
        <Button
          ref={bellRef}
          variant="ghost"
          size="icon"
          onClick={() => (open ? setOpen(false) : openDrawer())}
          aria-label={
            unread > 0 ? `Notifications, ${unread} new since you last looked` : 'Notifications'
          }
          aria-expanded={open}
          className="relative"
        >
          <BellIcon aria-hidden />
          {unread > 0 && (
            // Overlaid rather than inline: the header is width-constrained
            // enough that a growing count must not be able to reflow it.
            <span
              className={cn(
                'bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 inline-flex',
                'min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold',
              )}
              aria-hidden
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </Tooltip>

      {open && (
        <div
          ref={panelRef}
          // Anchored to the viewport rather than the button, so top-right
          // under the header is where it always is. The offsets follow the
          // header's height, which is h-14 until xl.
          className={cn(
            'fixed top-14 right-2 z-50 sm:right-3 xl:top-16',
            'w-[min(26rem,calc(100vw-1rem))]',
          )}
        >
          <aside
            role="dialog"
            // Not aria-modal: nothing behind it is inert, and claiming
            // otherwise would tell a screen reader the rest of the page is
            // unavailable when it is still perfectly usable.
            aria-label="Notifications"
            className={cn(
              'bg-popover border-border flex max-h-[min(32rem,calc(100dvh-5rem))] flex-col',
              'overflow-hidden rounded-lg border shadow-2xl',
              // Enter only -- this panel has no exit delay to animate into, it
              // just unmounts. A one-way slide is still worth having: without
              // it the whole drawer used to snap into place with no read on
              // where it came from.
              'animate-in fade-in slide-in-from-top-2 duration-150',
            )}
          >
            {/*
              A solid bar, the display face, and a clear size jump over the row
              titles. Without all three this sat at row weight on the row
              background and read as the first item in the list rather than the
              thing naming it. No icon: the bell that opened the panel is
              directly above it, and repeating it here just adds an object to
              parse before the word that matters.
            */}
            <header
              className={cn(
                'border-border bg-muted flex shrink-0 items-start justify-between gap-2',
                'border-b-2 px-4 py-3',
              )}
            >
              <div className="min-w-0">
                <h2 className="font-display text-base leading-tight font-bold tracking-tight">
                  Notifications
                </h2>
                <p className="text-muted-foreground mt-1 text-2xs leading-snug">
                  Probable drone activity in range, and what this console saw happen
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip content="Choose what appears here">
                  <Link
                    to="/settings/notifications"
                    onClick={() => setOpen(false)}
                    aria-label="Notification settings"
                    className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }))}
                  >
                    <SettingsIcon className="size-4" aria-hidden />
                  </Link>
                </Tooltip>
                <Tooltip content="Close">
                  <Button
                    ref={closeRef}
                    variant="ghost"
                    size="icon"
                    onClick={() => setOpen(false)}
                    aria-label="Close notifications"
                  >
                    <XIcon className="size-4" aria-hidden />
                  </Button>
                </Tooltip>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {feed.length === 0 ? (
                <EmptyFeed onNavigate={() => setOpen(false)} />
              ) : (
                <ul className="divide-border divide-y">
                  {feed.map((item) => (
                    <li key={item.id}>
                      <NotificationRow item={item} onNavigate={() => setOpen(false)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

/**
 * Two different empty states in one, because they mean opposite things: an
 * operator who has switched every category off should not be told the sky was
 * quiet.
 */
function EmptyFeed({ onNavigate }: { onNavigate: () => void }) {
  const { preferences } = usePreferences()
  const categories = preferences.notifyCategories
  const allOff = Object.values(categories).every((on) => !on)
  const anyConfigured = Object.keys(categories).length > 0

  if (allOff && anyConfigured) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        Every notification category is switched off, so nothing can appear here — this is not a
        quiet sky.{' '}
        <Link
          to="/settings/notifications"
          onClick={onNavigate}
          className="text-primary underline-offset-2 hover:underline"
        >
          Turn some back on
        </Link>
        .
      </p>
    )
  }

  return (
    <p className="text-muted-foreground p-4 text-sm">
      Nothing recorded yet. The receiver records continuously, so an empty list means a quiet
      sky rather than a fault — if in doubt, check the recording indicator and sensor health.
    </p>
  )
}

function NotificationRow({ item, onNavigate }: { item: Notification; onNavigate: () => void }) {
  const format = useFormat()
  // Relative ages are only honest if they advance. Nothing re-renders this
  // drawer on a quiet sky, so it drives its own clock -- slowly, since the
  // ages it shows are coarse anyway.
  useTicker(5000)

  const Icon = CATEGORY_ICON[item.category]
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            'truncate text-xs',
            item.category === 'drone' ? 'font-mono' : 'font-medium',
          )}
        >
          {item.title}
        </span>
        <span className="text-muted-foreground shrink-0 text-2xs">
          {format.relative(item.at)}
        </span>
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs">
        <span className="inline-flex items-center gap-1">
          <Icon className="size-3" aria-hidden />
          {NOTIFY_CATEGORY_LABEL[item.category]}
        </span>
        {item.meta.map((entry) => (
          <span key={entry}>{entry}</span>
        ))}
        {/* Always shown for a drone: a track is evidence, not proof. */}
        {item.confidence !== undefined && (
          <span>{format.confidence(item.confidence)} confidence</span>
        )}
      </div>
      {item.level === 'warn' || item.level === 'error' ? (
        <Badge variant={item.level === 'error' ? 'down' : 'warn'} className="mt-1.5 uppercase">
          {item.level}
        </Badge>
      ) : null}
    </>
  )

  if (item.trackId) {
    return (
      <Link
        to="/tracks/$trackId"
        params={{ trackId: item.trackId }}
        onClick={onNavigate}
        className="hover:bg-accent/50 block px-4 py-3"
      >
        {body}
      </Link>
    )
  }

  // Not every event has somewhere to go. A row that looks clickable and is not
  // is worse than a plain one.
  return <div className="px-4 py-3">{body}</div>
}

const STORAGE_KEY = 'classg.notifications.lastSeenAt'

function readLastSeen(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? Number(raw) || 0 : 0
  } catch {
    // Private browsing and similar. An always-unread badge is a far smaller
    // problem than a drawer that will not open.
    return 0
  }
}

function writeLastSeen(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* ignore */
  }
}

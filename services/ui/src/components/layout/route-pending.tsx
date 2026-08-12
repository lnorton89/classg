import { LoaderCircleIcon } from 'lucide-react'

/**
 * What fills the shell while a route's loader is still running.
 *
 * Without one, TanStack renders *nothing* for a pending route — not the
 * navigation, not the header, nothing — so a slow first request on a Pi is a
 * blank white page. That is the worst possible screen for this app to show,
 * because a blank screen is also what "no coverage" looks like at a glance, and
 * the whole console is built around never letting absence be ambiguous.
 *
 * Deliberately plain. It appears for a fraction of a second on a healthy link
 * and only becomes noticeable on the connection where it matters — the phone on
 * the Pi's own access point — so it needs to say "working", not entertain.
 */
export function RoutePending() {
  return (
    <div
      role="status"
      className="text-muted-foreground flex min-h-64 flex-1 items-center justify-center gap-2 p-6 text-sm"
    >
      {/* The reduce-motion preference kills the animation globally via
          :root[data-motion='reduced'] in styles.css, so the icon simply sits
          still there rather than needing its own branch. */}
      <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
      Loading…
    </div>
  )
}

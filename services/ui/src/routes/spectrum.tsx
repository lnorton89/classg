import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/spectrum` folded into Sensors — the SDR sweep and Wi-Fi occupancy are each
 * a specific sensor's own detail, not a subject of their own.
 *
 * Kept as a redirect rather than deleted: this URL has been in browser
 * bookmarks, and a 404 on a page someone reaches for mid-watch is a worse
 * outcome than an extra route file.
 */
export const Route = createFileRoute('/spectrum')({
  beforeLoad: () => {
    // TanStack signals a redirect by throwing a plain object, not an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/sensors' })
  },
})

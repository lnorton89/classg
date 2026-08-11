import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/config` became Settings › Calibration.
 *
 * Kept as a redirect rather than deleted: this URL has been in the operator
 * guide and in browser bookmarks, and a 404 on a page someone reaches for
 * mid-watch is a worse outcome than an extra route file.
 */
export const Route = createFileRoute('/config')({
  beforeLoad: () => {
    // TanStack signals a redirect by throwing a plain object, not an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/settings/calibration' })
  },
})

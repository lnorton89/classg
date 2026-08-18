import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/settings` has no content of its own — landing on it should show the first
 * category rather than an empty pane next to a populated nav.
 */
export const Route = createFileRoute('/settings/')({
  beforeLoad: () => {
    // TanStack signals a redirect by throwing a plain object, not an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/settings/general' })
  },
})

import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/')({
  beforeLoad: () => {
    // TanStack redirects are intentionally thrown to stop route loading.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/docs/$docId', params: { docId: 'operator-guide' } })
  },
})

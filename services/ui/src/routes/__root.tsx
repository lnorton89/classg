import { type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import { AppShell } from '@/components/layout/app-shell'
import { Alert } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/client'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
})

export function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

function NotFound() {
  return (
    <div className="p-6">
      <Alert tone="info" title="Page not found">
        That route does not exist. Use the navigation above to get back to the live map.
      </Alert>
    </div>
  )
}

function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const isApi = error instanceof ApiError
  return (
    <div className="p-6">
      <Alert
        tone="error"
        title={isApi ? `API error: ${error.code}` : 'Something went wrong'}
        action={
          <Button variant="outline" size="sm" onClick={reset}>
            Retry
          </Button>
        }
      >
        <p>{error.message}</p>
        {isApi && error.status === 0 ? (
          <p className="mt-1">
            The API did not respond. On the Pi, check that the <code>classg-api</code> service
            is running.
          </p>
        ) : null}
      </Alert>
    </div>
  )
}

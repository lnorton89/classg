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

function RootLayout() {
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

/**
 * Inside `AppShell`, unlike the not-found case, which the router already
 * renders within it.
 *
 * An `errorComponent` on the ROOT route replaces the root's component
 * outright — so a loader that threw took the header, the navigation, the sensor
 * status and the offline banner down with it, leaving one red box on an
 * otherwise empty page and no way to reach another route. The state that
 * triggers it most often is the API being unreachable, which is precisely when
 * an operator needs the status cluster and the "this is not the live sky"
 * banner most, and when "the console is blank" is the worst thing the screen
 * could say.
 */
function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const isApi = error instanceof ApiError

  // A 401 from a loader is not an error, it is not being signed in yet.
  //
  // Route loaders run before the auth gate renders, so opening the console
  // signed out threw one and this component turned it into a red box reading
  // "API error: unauthenticated — log in to continue" with a Retry button.
  // Signing in did not clear it: nothing re-runs a loader that already failed,
  // so the operator landed on an error about being signed out while signed in.
  //
  // Rendering the shell instead hands the decision to AuthGate, which shows the
  // login screen and then the page. The loaders re-run on the router
  // invalidation the login mutation issues.
  if (isApi && error.status === 401) {
    return <AppShell>{null}</AppShell>
  }

  return (
    <AppShell>
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
    </AppShell>
  )
}

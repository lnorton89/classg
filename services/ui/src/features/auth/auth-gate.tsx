/**
 * The gate every route waits behind.
 *
 * Three states, and the whole point is that they are distinguishable:
 *
 *   - the unit has no accounts yet    → the setup screen
 *   - nobody is logged in             → the login screen
 *   - somebody is                     → the app
 *
 * Getting these confused is the classic failure. A fresh unit that shows a
 * login form leaves the operator typing credentials that cannot exist; a
 * 403 that shows a login form makes a working session look broken.
 *
 * **This is not the security** for ROLES. Hiding a button a viewer cannot use
 * is a courtesy; the API refusing the request is what actually protects
 * anything, and nothing here should be the only thing between a role and an
 * action.
 *
 * It IS the boundary for what an unauthenticated visitor can see in the client.
 * The gate wraps the whole shell, so on the login and setup screens no header,
 * no navigation, no status pills, no command palette and no track alerts mount
 * at all -- none of those components exist to render, so none of them fetch and
 * none of them leak. Previously it sat inside <main> and every one of them was
 * on screen before sign-in, including toasts announcing live detections.
 */
import { useQuery } from '@tanstack/react-query'
import { RotateCwIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/misc'
import { authMeQuery } from '@/lib/api/queries'
import { LoginScreen } from './login-screen'
import { SetupScreen } from './setup-screen'

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useQuery(authMeQuery())

  if (me.isPending) {
    // Deliberately blank rather than a skeleton of the app. A skeleton of the
    // signed-in layout is itself a hint about what is behind the login.
    return (
      <AuthChrome>
        <Skeleton className="h-40 w-full" />
      </AuthChrome>
    )
  }

  // The API is unreachable. Not a login problem, and saying "log in" here would
  // send someone to type a password at a server that is not answering. The query
  // keeps retrying on its own (see authMeQuery), so this screen is a degraded
  // state that heals itself when the API returns -- not a dead end.
  if (me.isError && !me.data) {
    return (
      <div className="mx-auto w-full max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold">The API is not answering</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          This is not a sign-in problem — the browser could not reach the ClassG API at all.
          Check that the service is running.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          disabled={me.isFetching}
          onClick={() => void me.refetch()}
        >
          <RotateCwIcon className="size-4" aria-hidden />
          {me.isFetching ? 'Trying…' : 'Try again now'}
        </Button>
        <p className="text-muted-foreground/70 mt-3 text-xs">
          Retrying automatically every few seconds.
        </p>
      </div>
    )
  }

  const data = me.data

  if (data.auth_enabled && data.setup_required) {
    return (
      <AuthChrome>
        <SetupScreen />
      </AuthChrome>
    )
  }
  if (data.auth_enabled && !data.authenticated) {
    return (
      <AuthChrome>
        <LoginScreen providers={data.providers} />
      </AuthChrome>
    )
  }

  return <>{children}</>
}

/**
 * The only chrome an unauthenticated visitor gets: a page, centred, on the
 * app's background. No header, no navigation, no status.
 *
 * It carries the safe-area insets itself because the header -- which normally
 * owns them -- is not rendered here.
 */
function AuthChrome({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background safe-top safe-x safe-bottom flex min-h-dvh flex-col justify-center">
      <div className="mx-auto w-full max-w-sm px-4 py-8">{children}</div>
    </div>
  )
}

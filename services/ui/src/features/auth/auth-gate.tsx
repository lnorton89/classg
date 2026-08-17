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
 * **This is not the security.** Hiding a button a viewer cannot use is a
 * courtesy; the API refusing the request is what actually protects anything.
 * Nothing here should ever be the only thing standing between a role and an
 * action.
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { Skeleton } from '@/components/ui/misc'
import { authMeQuery } from '@/lib/api/queries'
import { LoginScreen } from './login-screen'
import { SetupScreen } from './setup-screen'

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useQuery(authMeQuery())

  if (me.isPending) {
    return (
      <div className="mx-auto w-full max-w-md p-8">
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  // The API is unreachable. Not a login problem, and saying "log in" here would
  // send someone to type a password at a server that is not answering.
  if (me.isError && !me.data) {
    return (
      <div className="mx-auto w-full max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold">The API is not answering</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          This is not a sign-in problem — the browser could not reach the ClassG API at all.
          Check that the service is running.
        </p>
      </div>
    )
  }

  const data = me.data

  if (data.auth_enabled && data.setup_required) return <SetupScreen />
  if (data.auth_enabled && !data.authenticated)
    return <LoginScreen providers={data.providers} />

  return <>{children}</>
}

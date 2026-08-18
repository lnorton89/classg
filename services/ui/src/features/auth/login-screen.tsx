/**
 * Sign in.
 *
 * Deliberately says nothing about why a login failed beyond what the API said,
 * which is one message for both a wrong username and a wrong password. Helpful
 * copy here ("no such user") would undo the API's account-enumeration defence
 * from the other end.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { LogInIcon } from 'lucide-react'
import { useState } from 'react'

import { ClassGLogo } from '@/components/brand/classg-logo'
import { Button } from '@/components/ui/button'
import { FormField, Input } from '@/components/ui/field'
import { Alert } from '@/components/ui/misc'
import { ApiError, api } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queries'
import type { SsoProvider } from '@/lib/api/types'

export function LoginScreen({ providers }: { providers?: SsoProvider[] }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // An error carried in the query string, put there by the SSO callback when it
  // could not complete. It redirects rather than rendering JSON, because the
  // browser got here by following the provider's redirect and a raw error
  // document is a dead end for whoever is looking at it.
  const ssoError = new URLSearchParams(window.location.search).get('error')

  const login = useMutation({
    mutationFn: () => api.login({ username, password }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.authMe, me)
      // Everything cached was fetched as nobody. Drop it rather than showing a
      // signed-in user a page assembled from anonymous 401s.
      void queryClient.invalidateQueries()
      // And re-run the ROUTE LOADERS, which invalidateQueries does not touch.
      // A loader that threw a 401 while signed out has already been caught by
      // the router's error boundary, and no amount of cache invalidation
      // re-runs it -- so the first page after signing in was an error box
      // about not being signed in.
      void router.invalidate()
    },
  })
  const error = login.error instanceof ApiError ? login.error : null

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <ClassGLogo className="h-8" />
        <p className="text-muted-foreground text-sm">Sign in to this receiver.</p>
      </div>

      {ssoError ? (
        <Alert tone="warn" title="Single sign-on did not complete" className="mb-4">
          {ssoError}
        </Alert>
      ) : null}

      {error ? (
        <Alert
          tone={error.code === 'forbidden' ? 'warn' : 'error'}
          title={error.code === 'forbidden' ? 'Account unavailable' : 'Sign-in failed'}
          className="mb-4"
        >
          {error.message}
        </Alert>
      ) : null}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          login.mutate()
        }}
      >
        <FormField label="Username">
          {(props) => (
            <Input
              {...props}
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </FormField>

        <Button
          type="submit"
          className="w-full"
          disabled={login.isPending || !username || !password}
        >
          <LogInIcon className="size-4" aria-hidden />
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {providers && providers.length > 0 ? (
        <div className="mt-4">
          <div className="text-muted-foreground mb-3 flex items-center gap-3 text-2xs">
            <span className="bg-border h-px flex-1" />
            or
            <span className="bg-border h-px flex-1" />
          </div>
          {providers.map((p) => (
            <Button
              key={p.id}
              variant="outline"
              className="w-full"
              // A full navigation, not a fetch: the provider redirects back
              // with a code and an XHR cannot follow that.
              onClick={() => {
                window.location.href = api.ssoStartUrl(window.location.pathname)
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

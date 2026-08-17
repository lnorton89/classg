/**
 * First run: create the administrator.
 *
 * This exists so the unit ships with no default password. A default is the most
 * reliable way to end up with an internet-facing box running admin/admin, and
 * the endpoint behind this screen closes permanently the moment it succeeds.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldCheckIcon } from 'lucide-react'
import { useState } from 'react'

import { ClassGLogo } from '@/components/brand/classg-logo'
import { Button } from '@/components/ui/button'
import { FormField, Input } from '@/components/ui/field'
import { Alert } from '@/components/ui/misc'
import { ApiError, api } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queries'

/** Mirrors auth.MinPasswordLength. The API is the one that enforces it. */
const MIN_PASSWORD = 12

export function SetupScreen() {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const setup = useMutation({
    mutationFn: () => api.setupFirstAdmin({ username, display_name: displayName, password }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.authMe, me)
      void queryClient.invalidateQueries()
    },
  })
  const error = setup.error instanceof ApiError ? setup.error : null

  const mismatch = confirm.length > 0 && confirm !== password
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD
  const ready = username.length >= 2 && password.length >= MIN_PASSWORD && confirm === password

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <ClassGLogo className="h-8" />
        <div>
          <h1 className="flex items-center justify-center gap-2 text-base font-semibold">
            <ShieldCheckIcon className="size-4" aria-hidden />
            Set up this receiver
          </h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            This unit has no accounts yet. Create the administrator — there is no default
            password, and this screen closes for good once you are done.
          </p>
        </div>
      </div>

      {error ? (
        <Alert tone="error" title="Could not create the account" className="mb-4">
          {error.message}
        </Alert>
      ) : null}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          setup.mutate()
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
        <FormField label="Display name" hint="optional">
          {(props) => (
            <Input
              {...props}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Password"
          hint={`at least ${MIN_PASSWORD} characters — a passphrase is fine`}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Confirm password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
        </FormField>

        {tooShort ? (
          <p className="text-warn text-xs">
            {MIN_PASSWORD - password.length} more character
            {MIN_PASSWORD - password.length === 1 ? '' : 's'} needed. Length is the only rule —
            no symbol or capital is required.
          </p>
        ) : null}
        {mismatch ? <p className="text-down text-xs">The passwords do not match.</p> : null}

        <Button type="submit" className="w-full" disabled={!ready || setup.isPending}>
          {setup.isPending ? 'Creating…' : 'Create administrator'}
        </Button>
      </form>
    </div>
  )
}

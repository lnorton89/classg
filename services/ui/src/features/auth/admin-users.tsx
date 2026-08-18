/**
 * Accounts and live sessions.
 *
 * Two refusals are surfaced rather than hidden, because both are states the API
 * enforces and a UI that pretended otherwise would produce a confusing 409:
 * the last enabled admin cannot be demoted, disabled or deleted, and you cannot
 * delete the account you are signed in with.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRoundIcon, Trash2Icon, UserPlusIcon, XIcon } from 'lucide-react'
import { useState } from 'react'

import { useFormat } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FormField, Input } from '@/components/ui/field'
import { Alert, EmptyState, Skeleton } from '@/components/ui/misc'
import { Select } from '@/components/ui/select'
import { ApiError, api } from '@/lib/api/client'
import { queryKeys, sessionsQuery, usersQuery } from '@/lib/api/queries'
import { cn } from '@/lib/cn'
import type { AuthSession, AuthUser, Role } from '@/lib/api/types'

import { useAuth } from './use-auth'

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'viewer', label: 'Viewer — read only' },
  { value: 'operator', label: 'Operator — can act on hardware' },
  { value: 'admin', label: 'Admin — can manage accounts' },
]

export function AdminUsers() {
  const me = useAuth()
  const users = useQuery(usersQuery())
  const sessions = useQuery(sessionsQuery())

  return (
    <div className="space-y-4">
      {me && !me.auth_enabled ? (
        <Alert tone="warn" title="Authentication is disabled on this unit">
          <code className="font-mono text-xs">CLASSG_AUTH_MODE=off</code> — every request is
          treated as an administrator, and these accounts are not consulted. Set it back to{' '}
          <code className="font-mono text-xs">required</code> and restart to enforce them.
        </Alert>
      ) : null}

      <CreateUserCard />

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            Roles are ordered: a viewer reads, an operator acts on the hardware, an admin
            changes who exists.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {users.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : users.data && users.data.users.length > 0 ? (
            <ul className="divide-border/60 divide-y">
              {users.data.users.map((u) => (
                <UserRow key={u.user_id} user={u} isSelf={u.user_id === me?.user?.user_id} />
              ))}
            </ul>
          ) : (
            <EmptyState title="No accounts" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Every signed-in browser. Revoking one takes effect on its next request — sessions
            are checked against the database rather than trusted from a token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : sessions.data && sessions.data.sessions.length > 0 ? (
            <ul className="divide-border/60 divide-y">
              {sessions.data.sessions.map((s) => (
                <SessionRow key={s.session_id} session={s} />
              ))}
            </ul>
          ) : (
            <EmptyState title="No active sessions" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CreateUserCard() {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [open, setOpen] = useState(false)

  const create = useMutation({
    mutationFn: () => api.createUser({ username, display_name: displayName, password, role }),
    onSuccess: () => {
      setUsername('')
      setDisplayName('')
      setPassword('')
      setRole('viewer')
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.users })
    },
  })
  const error = create.error instanceof ApiError ? create.error : null

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <UserPlusIcon className="size-4" aria-hidden />
        Add an account
      </Button>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert tone="error" title="Could not create the account">
            {error.message}
          </Alert>
        ) : null}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <FormField label="Username">
            {(props) => (
              <Input
                {...props}
                value={username}
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
          <FormField label="Password" hint="at least 12 characters">
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
          <FormField label="Role">
            {(props) => (
              <Select
                {...props}
                aria-label="Role"
                value={role}
                onValueChange={setRole}
                options={ROLE_OPTIONS}
              />
            )}
          </FormField>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={create.isPending || !username || !password}>
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function UserRow({ user, isSelf }: { user: AuthUser; isSelf: boolean }) {
  const queryClient = useQueryClient()
  const format = useFormat()
  const [resetting, setResetting] = useState(false)
  const [newPassword, setNewPassword] = useState('')

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users })
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
  }

  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateUser>[1]) =>
      api.updateUser(user.user_id, body),
    onSuccess: () => {
      setResetting(false)
      setNewPassword('')
      invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteUser(user.user_id),
    onSuccess: invalidate,
  })

  const error =
    (update.error instanceof ApiError ? update.error : null) ??
    (remove.error instanceof ApiError ? remove.error : null)

  const isSSO = Boolean(user.issuer)

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn('text-sm font-medium', user.disabled && 'text-muted-foreground')}>
          {user.username}
        </span>
        {user.display_name ? (
          <span className="text-muted-foreground text-xs">{user.display_name}</span>
        ) : null}
        {isSelf ? <Badge variant="outline">you</Badge> : null}
        {isSSO ? <Badge variant="muted">SSO</Badge> : null}
        {user.disabled ? <Badge variant="down">disabled</Badge> : null}

        {/* Its own full-width row on a phone, beside the name from sm up.
            It was `ml-auto flex` with no wrap around a fixed-width select and
            three buttons -- about 440px of controls in a 330px row -- so
            "Reset password" ran off the right edge of the screen and there was
            no way to reach it. */}
        <div
          className={cn(
            'flex w-full flex-wrap items-center gap-2',
            'sm:ml-auto sm:w-auto sm:flex-nowrap',
          )}
        >
          <Select
            aria-label={`Role for ${user.username}`}
            value={user.role}
            onValueChange={(role) => update.mutate({ role })}
            options={ROLE_OPTIONS}
            disabled={update.isPending}
            className="w-full min-w-0 sm:w-44"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ disabled: !user.disabled })}
            disabled={update.isPending}
          >
            {user.disabled ? 'Enable' : 'Disable'}
          </Button>
          {/* An SSO account has no password to reset. */}
          {!isSSO ? (
            <Button size="sm" variant="ghost" onClick={() => setResetting((v) => !v)}>
              <KeyRoundIcon className="size-3.5" aria-hidden />
              Reset password
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => remove.mutate()}
            disabled={remove.isPending || isSelf}
            aria-label={`Delete ${user.username}`}
            // Deleting the account you are signed in with is almost always a
            // misclick; the API refuses it too.
            title={isSelf ? 'You cannot delete the account you are signed in with' : undefined}
          >
            <Trash2Icon className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground mt-1 text-2xs">
        Created {format.timestamp(user.created_at)}
        {user.last_login_at
          ? ` · last signed in ${format.timestamp(user.last_login_at)}`
          : ' · never signed in'}
      </p>

      {resetting ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            update.mutate({ password: newPassword })
          }}
        >
          <div className="min-w-56 flex-1">
            <FormField label="New password" hint="ends every session for this account">
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  value={newPassword}
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              )}
            </FormField>
          </div>
          <Button type="submit" size="sm" disabled={update.isPending || !newPassword}>
            Set
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setResetting(false)}>
            Cancel
          </Button>
        </form>
      ) : null}

      {error ? (
        <Alert tone={error.code === 'conflict' ? 'warn' : 'error'} title="" className="mt-2">
          {error.message}
        </Alert>
      ) : null}
    </li>
  )
}

function SessionRow({ session }: { session: AuthSession }) {
  const queryClient = useQueryClient()
  const format = useFormat()
  const revoke = useMutation({
    mutationFn: () => api.revokeSession(session.session_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  })

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
      <span className="font-medium">{session.username}</span>
      {session.current ? <Badge variant="ok">this browser</Badge> : null}
      <span className="text-muted-foreground truncate">
        {session.user_agent && session.user_agent.length > 0
          ? session.user_agent
          : 'unknown client'}
      </span>
      {session.ip ? (
        <span className="text-muted-foreground font-mono">{session.ip}</span>
      ) : null}
      <span className="text-muted-foreground ml-auto">
        last seen {format.timestamp(session.last_seen)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => revoke.mutate()}
        disabled={revoke.isPending}
      >
        <XIcon className="size-3.5" aria-hidden />
        Revoke
      </Button>
    </li>
  )
}

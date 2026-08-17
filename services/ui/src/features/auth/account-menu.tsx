/**
 * Who you are, and the way out.
 *
 * Also carries the auth-disabled warning. That belongs here rather than in a
 * dismissible banner: an auth-disabled box that nobody remembers disabling is
 * worse than one that never had authentication, so the reminder sits next to
 * the identity control and does not go away.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { LogOutIcon, ShieldAlertIcon, ShieldCheckIcon, UserIcon } from 'lucide-react'

import { Tooltip } from '@/components/ui/tooltip'
import { buttonVariants } from '@/components/ui/button-variants'
import { api } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queries'
import { cn } from '@/lib/cn'

import { useAuth } from './use-auth'

export function AccountMenu() {
  const queryClient = useQueryClient()
  const me = useAuth()

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      // Clear everything, not just the session: the cache holds data fetched
      // as the signed-in user, and leaving it would show the next person at
      // this browser the previous one's tracks until each query refetched.
      queryClient.clear()
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe })
    },
  })

  if (!me) return null

  if (!me.auth_enabled) {
    return (
      <Tooltip content="Authentication is disabled (CLASSG_AUTH_MODE=off) — every request is treated as an administrator">
        <Link
          to="/admin"
          aria-label="Authentication is disabled"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'text-warn hover:text-warn',
          )}
        >
          <ShieldAlertIcon className="size-4" aria-hidden />
        </Link>
      </Tooltip>
    )
  }

  if (!me.authenticated || !me.user) return null

  // Truthiness, not nullish: a display name set to an empty string should fall
  // through to the username rather than rendering as a blank identity.
  const label =
    me.user.display_name && me.user.display_name.length > 0
      ? me.user.display_name
      : me.user.username

  return (
    <div className="flex items-center">
      <Tooltip content={`${label} — ${me.user.role}`}>
        <Link
          to={me.user.role === 'admin' ? '/admin' : '/settings'}
          aria-label={`Signed in as ${label}, role ${me.user.role}`}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'text-muted-foreground hover:text-foreground',
          )}
        >
          {me.user.role === 'admin' ? (
            <ShieldCheckIcon className="size-4" aria-hidden />
          ) : (
            <UserIcon className="size-4" aria-hidden />
          )}
        </Link>
      </Tooltip>
      <Tooltip content="Sign out">
        <button
          type="button"
          aria-label="Sign out"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'text-muted-foreground hover:text-foreground',
          )}
        >
          <LogOutIcon className="size-4" aria-hidden />
        </button>
      </Tooltip>
    </div>
  )
}

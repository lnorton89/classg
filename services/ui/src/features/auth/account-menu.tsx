/**
 * Who you are, and everything that follows from it.
 *
 * This was two bare icon buttons in the header — a shield that linked
 * somewhere and an arrow that signed you out — sitting alongside seven other
 * controls in a row that did not fit a phone. Neither icon said what it did,
 * and "shield" and "door" are not a menu.
 *
 * It is a menu now, and it absorbed the two controls that had no business
 * spending header width of their own: Settings, which is somewhere you go once
 * to set the console up, and the command palette, which on a phone is a
 * keyboard accelerator with no keyboard.
 *
 * It still carries the auth-disabled warning, and that still does not go away.
 * A box whose authentication somebody switched off and forgot is worse than
 * one that never had any.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UserIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Popover } from '@/components/ui/popover'
import { Tooltip } from '@/components/ui/tooltip'
import { buttonVariants } from '@/components/ui/button-variants'
import { api } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queries'
import { cn } from '@/lib/cn'

import { useAuth } from './use-auth'

export function AccountMenu({ onOpenPalette }: { onOpenPalette: () => void }) {
  const queryClient = useQueryClient()
  const me = useAuth()
  const [open, setOpen] = useState(false)

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

  const user = me.user
  // Truthiness, not nullish: a display name set to an empty string should fall
  // through to the username rather than rendering as a blank identity.
  const label =
    user.display_name && user.display_name.length > 0 ? user.display_name : user.username
  const close = () => setOpen(false)

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      aria-label="Account"
      trigger={
        <button
          type="button"
          aria-label={`Signed in as ${label}, role ${user.role}. Open the account menu.`}
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-accent',
            'flex size-8 shrink-0 items-center justify-center rounded-full border border-transparent',
            'transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          {user.role === 'admin' ? (
            <ShieldCheckIcon className="size-4" aria-hidden />
          ) : (
            <UserIcon className="size-4" aria-hidden />
          )}
        </button>
      }
    >
      <div className="divide-border/60 divide-y">
        <div className="px-3 py-2.5">
          <p className="truncate text-sm font-medium">{label}</p>
          <p className="text-muted-foreground text-2xs">
            {user.username} · {user.role}
          </p>
        </div>

        <div className="p-1">
          {user.role === 'admin' ? (
            <MenuLink
              to="/admin"
              icon={<ShieldCheckIcon className="size-4" aria-hidden />}
              onSelect={close}
            >
              Administration
            </MenuLink>
          ) : null}
          <MenuLink
            to="/settings"
            icon={<SettingsIcon className="size-4" aria-hidden />}
            onSelect={close}
          >
            Settings
          </MenuLink>
          {/* Here rather than in the header at every width: it is a keyboard
              accelerator, and on a phone there is no keyboard to accelerate. */}
          <MenuButton
            icon={<SearchIcon className="size-4" aria-hidden />}
            onSelect={() => {
              close()
              onOpenPalette()
            }}
          >
            Search…
          </MenuButton>
        </div>

        <div className="p-1">
          <MenuButton
            icon={<LogOutIcon className="size-4" aria-hidden />}
            disabled={logout.isPending}
            onSelect={() => {
              close()
              logout.mutate()
            }}
          >
            Sign out
          </MenuButton>
        </div>
      </div>
    </Popover>
  )
}

const ITEM_CLASS =
  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ' +
  'text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ' +
  'disabled:opacity-50'

function MenuLink({
  to,
  icon,
  children,
  onSelect,
}: {
  to: string
  icon: ReactNode
  children: ReactNode
  onSelect: () => void
}) {
  return (
    <Link to={to} onClick={onSelect} className={ITEM_CLASS}>
      <span className="text-muted-foreground">{icon}</span>
      {children}
    </Link>
  )
}

function MenuButton({
  icon,
  children,
  onSelect,
  disabled,
}: {
  icon: ReactNode
  children: ReactNode
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" onClick={onSelect} disabled={disabled} className={ITEM_CLASS}>
      <span className="text-muted-foreground">{icon}</span>
      {children}
    </button>
  )
}

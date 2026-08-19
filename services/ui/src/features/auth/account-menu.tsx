/**
 * The gear: settings, and everything that follows from who you are.
 *
 * This was two icons in the header — a gear that linked straight to Settings,
 * and a shield or a person that opened this same menu — answering the same
 * question ("where do I manage this console") two different ways side by
 * side. One control now: the gear opens the menu, and Settings is the first
 * thing in it rather than a second button next to it.
 *
 * Before that it was two bare icon buttons — a shield that linked somewhere
 * and an arrow that signed you out — sitting alongside seven other controls
 * in a row that did not fit a phone. It absorbed the command palette, which
 * on a phone is a keyboard accelerator with no keyboard, and Logs and Docs,
 * which used to sit in the primary nav and made the bottom bar seven
 * destinations deep. Neither is reached for mid-incident the way Live or
 * Tracks is, so both live here instead, one tap away at every width.
 *
 * It still carries the auth-disabled warning, and that still does not go away.
 * A box whose authentication somebody switched off and forgot is worse than
 * one that never had any.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  BookOpenIcon,
  LogOutIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Popover } from '@/components/ui/popover'
import { useMenuKeys } from '@/components/ui/use-menu-keys'
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
  const [menuRef, onMenuKeyDown] = useMenuKeys()

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
          aria-label={`Settings. Signed in as ${label}, role ${user.role}.`}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'text-muted-foreground hover:text-foreground',
          )}
        >
          <SettingsIcon className="size-4" aria-hidden />
        </button>
      }
    >
      <div
        ref={menuRef}
        onKeyDown={onMenuKeyDown}
        role="menu"
        aria-label="Account"
        // A menu owns arrow-key focus, so the container itself must be
        // focusable to receive the keydown before an item has focus.
        tabIndex={-1}
        className="divide-border/60 divide-y"
      >
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
          {/* Moved out of the primary nav: neither is a screen an operator
              watches, so neither earns a permanent slot in the bottom bar. */}
          <MenuLink
            to="/logs"
            icon={<ScrollTextIcon className="size-4" aria-hidden />}
            onSelect={close}
          >
            Logs
          </MenuLink>
          <MenuLink
            to="/docs"
            icon={<BookOpenIcon className="size-4" aria-hidden />}
            onSelect={close}
          >
            Docs
          </MenuLink>
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
    <Link to={to} role="menuitem" onClick={onSelect} className={ITEM_CLASS}>
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
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      disabled={disabled}
      className={ITEM_CLASS}
    >
      <span className="text-muted-foreground">{icon}</span>
      {children}
    </button>
  )
}

/**
 * Reading the current session.
 *
 * Split out of auth-gate.tsx so that file exports only a component: mixing
 * hooks and components in one module breaks React Fast Refresh, and these are
 * used from routes that never render the gate itself.
 *
 * **None of this is the security.** Hiding a control a viewer cannot use is a
 * courtesy; the API refusing the request is what protects anything. Nothing
 * here should ever be the only thing between a role and an action.
 */
import { useQuery } from '@tanstack/react-query'

import { authMeQuery } from '@/lib/api/queries'
import type { AuthMe, Role } from '@/lib/api/types'
import { roleAtLeast } from '@/lib/api/types'

/** The current session, or undefined while it loads. */
export function useAuth(): AuthMe | undefined {
  return useQuery(authMeQuery()).data
}

/**
 * Whether the signed-in user holds at least `need`.
 *
 * True when authentication is disabled -- in that mode the API treats every
 * request as an admin, and a UI that hid the controls anyway would be lying
 * about what the box will do.
 */
export function useHasRole(need: Role): boolean {
  const me = useAuth()
  if (!me) return false
  if (!me.auth_enabled) return true
  return roleAtLeast(me.user?.role, need)
}

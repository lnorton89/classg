import { createFileRoute } from '@tanstack/react-router'

import { AdminUsers } from '@/features/auth/admin-users'
import { DeploymentPanel } from '@/features/deploy/deployment-panel'
import { WatchdogPanel } from '@/features/deploy/watchdog-panel'
import { HooksPanel } from '@/features/hooks/hooks-panel'
import { useHasRole } from '@/features/auth/use-auth'

export const Route = createFileRoute('/admin')({
  component: AdminRoute,
})

function AdminRoute() {
  const isAdmin = useHasRole('admin')

  // A courtesy, not the gate. Every endpoint this page calls refuses a
  // non-admin on its own; this just avoids rendering a screen full of 403s.
  if (!isAdmin) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-8 text-center sm:px-6">
        <h1 className="text-lg font-semibold">Administration</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          This page needs the administrator role. You are signed in — this is not a sign-in
          problem.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6">
      <h1 className="text-lg font-semibold">Administration</h1>
      <p className="text-muted-foreground mt-1 mb-4 text-sm leading-relaxed">
        Who can use this receiver, and who is using it right now.
      </p>
      <div className="space-y-4">
        <WatchdogPanel />
        <DeploymentPanel />
        <HooksPanel />
        <AdminUsers />
      </div>
    </div>
  )
}

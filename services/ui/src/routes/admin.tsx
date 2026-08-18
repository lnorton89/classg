import { createFileRoute } from '@tanstack/react-router'
import { RocketIcon, ShieldCheckIcon, UsersIcon, WebhookIcon } from 'lucide-react'

import { PageContainer } from '@/components/layout/page-container'
import { PageHeader, SectionHeader } from '@/components/layout/page-header'
import { Alert } from '@/components/ui/misc'
import { AdminUsers } from '@/features/auth/admin-users'
import { DeployHistory } from '@/features/deploy/deploy-history'
import { DeploymentPanel } from '@/features/deploy/deployment-panel'
import { WatchdogPanel } from '@/features/deploy/watchdog-panel'
import { HooksPanel } from '@/features/hooks/hooks-panel'
import { useHasRole } from '@/features/auth/use-auth'

export const Route = createFileRoute('/admin')({
  component: AdminRoute,
})

/**
 * Three things an administrator does, in the order they do them.
 *
 * This was four unrelated cards stacked in one column under a heading that
 * promised "who can use this receiver, and who is using it right now" — and
 * then opened with the watchdog, followed by deployment and hooks, with the
 * accounts the sentence described last of the four. Somebody arriving to add
 * a user scrolled past three panels about infrastructure to reach the one
 * thing the page said it was for.
 *
 * Grouped now, and ordered by what brings people here: who can get in, then
 * what this unit does to itself, then what it says to the outside world. It
 * also uses PageContainer and PageHeader like every other route — it was
 * hand-rolling a different width and a different heading style, which is the
 * exact drift PageContainer exists to stop.
 */
function AdminRoute() {
  const isAdmin = useHasRole('admin')

  // A courtesy, not the gate. Every endpoint this page calls refuses a
  // non-admin on its own; this just avoids rendering a screen full of 403s.
  if (!isAdmin) {
    return (
      <PageContainer className="max-w-2xl">
        <PageHeader
          icon={ShieldCheckIcon}
          title="Administration"
          description="Accounts, sessions, deployment and outbound hooks."
        />
        <Alert tone="info" title="This page needs the administrator role">
          You are signed in — this is not a sign-in problem. An administrator can change your
          role from this page.
        </Alert>
      </PageContainer>
    )
  }

  return (
    <PageContainer className="max-w-5xl">
      <PageHeader
        icon={ShieldCheckIcon}
        title="Administration"
        description="Who can get in, what this unit does to itself, and what it tells the outside world."
      />

      <section aria-labelledby="admin-access" className="flex flex-col gap-2">
        <SectionHeader
          id="admin-access"
          icon={UsersIcon}
          title="Access"
          description="Accounts and the browsers currently signed in with them. Revoking a session takes effect on its next request."
        />
        <AdminUsers />
      </section>

      <section aria-labelledby="admin-unit" className="flex flex-col gap-2">
        <SectionHeader
          id="admin-unit"
          icon={RocketIcon}
          title="This unit"
          description="What it is running, and what it does about its own failures. Neither is driven from here — the API cannot run anything on the host, so both are file exchanges with agents that act on their own schedule."
        />
        <DeploymentPanel />
        <DeployHistory />
        <WatchdogPanel />
      </section>

      <section aria-labelledby="admin-hooks" className="flex flex-col gap-2">
        <SectionHeader
          id="admin-hooks"
          icon={WebhookIcon}
          title="Outbound"
          description="The only paths by which anything this receiver sees leaves it. Each one is an egress route to a URL or a mailbox somebody chose."
        />
        <HooksPanel />
      </section>
    </PageContainer>
  )
}

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  RocketIcon,
  ShieldCheckIcon,
  UsersIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react'
import { z } from 'zod'

import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { Alert } from '@/components/ui/misc'
import { AdminUsers } from '@/features/auth/admin-users'
import { useHasRole } from '@/features/auth/use-auth'
import { BoundariesPanel } from '@/features/boundaries/boundaries-panel'
import { DeployHistory } from '@/features/deploy/deploy-history'
import { DeploymentPanel } from '@/features/deploy/deployment-panel'
import { WatchdogPanel } from '@/features/deploy/watchdog-panel'
import { HooksPanel } from '@/features/hooks/hooks-panel'
import { cn } from '@/lib/cn'

const CATEGORY_VALUES = ['access', 'unit', 'outbound'] as const
type Category = (typeof CATEGORY_VALUES)[number]

// In the URL as `?section=`, not component state, so a reload or a shared
// link lands back on the category someone was reading instead of resetting
// to Access every time.
export const adminSearchSchema = z.object({
  section: z.enum(CATEGORY_VALUES).optional().catch(undefined),
})

export const Route = createFileRoute('/admin')({
  component: AdminRoute,
  validateSearch: adminSearchSchema,
})

interface CategoryEntry {
  key: Category
  label: string
  icon: LucideIcon
  hint: string
}

const CATEGORIES: CategoryEntry[] = [
  { key: 'access', label: 'Access', icon: UsersIcon, hint: 'Accounts and sessions' },
  { key: 'unit', label: 'This unit', icon: RocketIcon, hint: 'Deploy and self-repair' },
  { key: 'outbound', label: 'Outbound', icon: WebhookIcon, hint: 'Webhooks and email' },
]

/**
 * Three things an administrator does, one at a time.
 *
 * This was a stacked column, then a page where "This unit" and "Outbound"
 * sat side by side below a full-width "Access" — better than the original
 * four unordered cards, but still a page you scrolled through rather than a
 * page you moved around in. The left nav here is the same shape Settings and
 * Sensors already use: a short list of categories, the selected one's full
 * detail beside it, one destination showing at a time on a phone. Three
 * categories is not many, but the pattern is the same one an administrator
 * has already used twice by the time they reach this page, so it costs
 * nothing to learn a third time.
 */
export function AdminRoute() {
  const isAdmin = useHasRole('admin')
  const { section: selected } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // replace: true -- switching categories is not a new page to walk back
  // through with the browser's back button, the way opening this page was.
  function select(section: Category) {
    void navigate({ search: (prev) => ({ ...prev, section }), replace: true })
  }

  function goBack() {
    void navigate({ search: (prev) => ({ ...prev, section: undefined }), replace: true })
  }

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

  const effective = selected ?? 'access'

  return (
    <PageContainer>
      <PageHeader
        icon={ShieldCheckIcon}
        title="Administration"
        description="Who can get in, what this unit does to itself, and what it tells the outside world."
      />

      <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav
          aria-label="Administration categories"
          className={cn(
            'border-border bg-card/70 min-w-0 flex-col gap-0.5 rounded-lg border p-2 lg:sticky lg:top-20 lg:flex',
            selected ? 'hidden lg:flex' : 'flex',
          )}
        >
          {CATEGORIES.map((category) => (
            <CategoryRow
              key={category.key}
              category={category}
              active={effective === category.key}
              onSelect={() => select(category.key)}
            />
          ))}
        </nav>

        <div className={cn('min-w-0 flex-col gap-3', selected ? 'flex' : 'hidden lg:flex')}>
          <BackToCategories onBack={goBack} />
          <div
            key={effective}
            className="animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            {effective === 'access' ? <AdminUsers /> : null}
            {effective === 'unit' ? <UnitPanels /> : null}
            {effective === 'outbound' ? (
              <div className="space-y-4">
                <BoundariesPanel />
                <HooksPanel />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </PageContainer>
  )
}

function CategoryRow({
  category,
  active,
  onSelect,
}: {
  category: CategoryEntry
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <category.icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{category.label}</span>
        <span className="text-muted-foreground block truncate text-2xs">{category.hint}</span>
      </span>
    </button>
  )
}

function BackToCategories({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start rounded text-xs lg:hidden"
    >
      ← Administration
    </button>
  )
}

/**
 * Deployment, self-repair, deploy history — in that order, fixed.
 *
 * These were three draggable cards, remembered per browser. The reasoning was
 * that an administrator compares them against each other, and the cost was
 * that this page had no answer to "what am I looking at first": every layout
 * was equally endorsed, including the ones that put the deploy history above
 * the button that deploys. There is an order here, and it is the order of the
 * question being asked — is this unit current, is it repairing itself, and
 * what has it done before. Deployment is the page's one primary card; the
 * other two are the context for it.
 */
function UnitPanels() {
  return (
    <div className="flex flex-col gap-3">
      <DeploymentPanel />
      <WatchdogPanel />
      <DeployHistory />
    </div>
  )
}

import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { RotateCcwIcon, SettingsIcon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast-primitives'
import { log } from '@/features/logs/log-store'
import {
  SCOPE_HINT,
  SCOPE_LABEL,
  SETTINGS_CATEGORIES,
  type SettingsScope,
} from '@/features/settings/categories'
import { cn } from '@/lib/cn'

export const Route = createFileRoute('/settings')({ component: SettingsLayout })

const SCOPE_ORDER: SettingsScope[] = ['browser', 'receiver']

/**
 * Settings is one destination with a left nav, reached by the gear in the
 * header.
 *
 * It used to be two pages — `/settings` for display preferences and `/config`
 * for the instrument — both buried in a three-dot overflow menu, each with a
 * paragraph explaining that it was not the other one. That explaining is what a
 * grouped nav does without prose.
 */
function SettingsLayout() {
  return (
    <PageContainer>
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        description="How this console behaves, and how the receiver is calibrated. Everything under “This browser” applies the moment you change it; calibration is saved deliberately and may need a restart."
        actions={<ResetButton />}
      />

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <SettingsNav />
        {/* min-w-0 so a wide child — the channel plan table — scrolls inside
            its own container instead of stretching the grid column. */}
        <div className="flex min-w-0 flex-col gap-4">
          <Outlet />
        </div>
      </div>
    </PageContainer>
  )
}

function SettingsNav() {
  return (
    <nav
      aria-label="Settings categories"
      className="border-border bg-card/70 self-start rounded-lg border p-2 lg:sticky lg:top-20"
    >
      {SCOPE_ORDER.map((scope) => (
        <div key={scope} className="mb-2 last:mb-0">
          <p className="label-caps px-2 py-1.5">{SCOPE_LABEL[scope]}</p>
          <p className="text-muted-foreground mb-1 px-2 text-2xs leading-snug">
            {SCOPE_HINT[scope]}
          </p>
          <ul className="space-y-0.5">
            {SETTINGS_CATEGORIES.filter((category) => category.scope === scope).map(
              (category) => (
                <li key={category.to}>
                  <Link
                    to={category.to}
                    activeProps={{
                      className: 'bg-accent text-foreground',
                      'aria-current': 'page',
                    }}
                    inactiveProps={{
                      className:
                        'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    }}
                    className={cn(
                      'flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5',
                      'text-sm transition-colors',
                    )}
                  >
                    <category.icon className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{category.label}</span>
                      <span className="text-muted-foreground block truncate text-2xs">
                        {category.hint}
                      </span>
                    </span>
                  </Link>
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/**
 * Resets the browser-local preferences only. Calibration is not touched: it
 * lives on the receiver, and a reset button that quietly rewrote the channel
 * plan for every client would be a very expensive misclick.
 */
function ResetButton() {
  const { reset } = usePreferences()
  const toast = useToast()

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        reset()
        log.action('Display settings reset to defaults')
        toast.add({ title: 'Browser settings reset', type: 'success' })
      }}
    >
      <RotateCcwIcon aria-hidden /> Reset browser settings
    </Button>
  )
}

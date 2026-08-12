import { createFileRoute } from '@tanstack/react-router'
import { ScrollTextIcon } from 'lucide-react'

import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { LogsView } from '@/features/logs/logs-view'

export const Route = createFileRoute('/logs')({
  component: LogsRoute,
})

export function LogsRoute() {
  return (
    <PageContainer className="min-h-0 flex-1">
      <PageHeader
        icon={ScrollTextIcon}
        title="Event log"
        description="Everything this console has observed since the page was opened — stream connects and drops, track lifecycle, sensor health changes, captures, and your own actions, in the order they happened."
      />
      <LogsView />
    </PageContainer>
  )
}

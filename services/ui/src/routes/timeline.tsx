import { createFileRoute } from '@tanstack/react-router'
import { HistoryIcon } from 'lucide-react'

import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { TimelinePanel } from '@/features/timeline/timeline-panel'

export const Route = createFileRoute('/timeline')({
  component: TimelineView,
})

/**
 * The review screen. Live answers "what is up there now"; this answers "what
 * happened while I was not looking", which is the question an operator asks
 * first thing in the morning and the one a map cannot answer at all.
 */
function TimelineView() {
  return (
    <PageContainer>
      <PageHeader
        icon={HistoryIcon}
        title="Timeline"
        description="Tracks as events on a band of time. Pick a window, read across it, click a bar to open the track."
      />
      <TimelinePanel />
    </PageContainer>
  )
}

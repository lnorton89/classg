import { createFileRoute, Link } from '@tanstack/react-router'
import { ArchiveIcon } from 'lucide-react'

import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { CaptureHistory } from '@/features/captures/sensor-captures'
import { capturesQuery } from '@/lib/api/queries'

/**
 * The recordings, at their own URL.
 *
 * This was a redirect to `/sensors#captures`, and nothing on that page reads a
 * hash — so a bookmark landed on whichever sensor happened to be first and the
 * recordings were one more click away. It is a destination in the rail now,
 * and two rail entries cannot share one route: the router marks a link active
 * by matching its path, so Sensors and Captures pointing at the same path lit
 * both and made "where am I" unanswerable.
 *
 * It is also the only place the list lives. The Sensors page carried a second
 * copy of it behind `?view=captures`, which meant two URLs for one list and no
 * way for a link to say which one was meant; that page keeps the count, the
 * link here, and the per-sensor control that starts a recording — because a
 * capture is made BY a sensor even though it is read as evidence on its own.
 */
export const Route = createFileRoute('/captures/')({
  component: CapturesRoute,
  loader: ({ context }) => context.queryClient.ensureQueryData(capturesQuery()),
})

function CapturesRoute() {
  return (
    <PageContainer>
      <PageHeader
        icon={ArchiveIcon}
        title="Captures"
        description="PCAP and IQ recordings this unit has made. A capture is raw evidence: it is what the radio heard, not what fusion made of it."
        // A destination of its own rather than a page under Sensors, so no
        // breadcrumb — but a recording is always made BY a sensor, and that is
        // where one is started.
        actions={
          <Link
            to="/sensors"
            className="text-muted-foreground hover:text-foreground rounded text-xs"
          >
            Sensors →
          </Link>
        }
      />
      <CaptureHistory />
    </PageContainer>
  )
}

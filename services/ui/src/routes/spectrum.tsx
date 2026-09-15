import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { AudioWaveformIcon } from 'lucide-react'
import { z } from 'zod'

import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { Why } from '@/components/ui/why'
import { SpectrumPanel } from '@/features/spectrum/spectrum-panel'

/**
 * `/spectrum` is a destination again.
 *
 * It was folded into Sensors on the reasoning that a sweep is the SDR
 * sensor's own measurement rather than a subject of its own, and that reading
 * holds for what a sweep IS. It did not survive what a sweep is FOR: comparing
 * a band against itself over weeks ("is there something here that was not here
 * last week") is a task an operator comes to the console to do, and it was
 * reachable only by knowing to select sdr-0 and scroll past its health card.
 * A tool you have to already know about is a tool nobody uses.
 *
 * The sensor card keeps a link here, so the connection to the radio doing the
 * measuring is not lost.
 */
// In the URL so a link to a band is a link to that band. Same convention as
// routes/sensors.tsx and routes/tracks/index.tsx: optional, `.catch(undefined)`
// so a stale or hand-edited value degrades to the sensor's first band rather
// than throwing, and absent when unset.
export const spectrumSearchSchema = z.object({
  band: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/spectrum')({
  component: SpectrumRoute,
  validateSearch: spectrumSearchSchema,
})

function SpectrumRoute() {
  const { band } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <PageContainer>
      <PageHeader
        icon={AudioWaveformIcon}
        title="Spectrum"
        description={
          <>
            Sweep a band with the SDR and compare it against the sweeps before it.
            <Why label="Why is this a button rather than a live waterfall?" className="mt-1.5">
              There is one dongle and dump1090 has it (ADR-0008). A continuously updating view
              would mean permanent ADS-B blindness, so a sweep borrows the radio for one band
              and gives it back — which costs tens of seconds of no manned traffic, every time.
              Everything here reports <em>energy</em>: a peak above the noise floor means
              something is transmitting, never that it is a drone.
            </Why>
          </>
        }
        actions={
          // Not to a specific sensor id: which SDR this unit has is a property
          // of its configuration, and a link naming one that is not there is
          // worse than a link to the list that shows what is.
          <Link
            to="/sensors"
            className="text-muted-foreground hover:text-foreground rounded text-xs"
          >
            Sensors →
          </Link>
        }
      />

      <SpectrumPanel
        band={band}
        // replace: true -- picking a band is narrowing this page, not a new
        // page to walk back through, the same rule the Flights filters follow.
        onBandChange={(next) => {
          void navigate({ search: (prev) => ({ ...prev, band: next }), replace: true })
        }}
      />
    </PageContainer>
  )
}

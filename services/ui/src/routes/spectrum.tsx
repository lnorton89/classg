/**
 * Spectrum, from both radios.
 *
 * They see different things and neither can be swapped for the other. The SDR
 * sweeps 500 kHz – 1.766 GHz and produces power per frequency bin; it is the
 * only sensor that can see an aircraft flying ELRS or Crossfire. It cannot tune
 * 2.4 or 5 GHz at all (ADR-0004), which is exactly where DJI talks — so the
 * Wi-Fi adapter answers there instead, with the driver's own per-channel busy
 * time rather than an FFT it cannot produce.
 *
 * Split by source rather than stacked, because the two views measure different
 * quantities in different units and reading them as one chart would be reading
 * them wrong.
 */
import { createFileRoute } from '@tanstack/react-router'
import { AudioWaveformIcon, WifiIcon } from 'lucide-react'
import { useState } from 'react'

import { Segmented } from '@/components/ui/segmented'
import { SpectrumPanel } from '@/features/spectrum/spectrum-panel'
import { WifiOccupancyPanel } from '@/features/spectrum/wifi-occupancy'

export const Route = createFileRoute('/spectrum')({
  component: SpectrumRoute,
})

type Source = 'sdr' | 'wifi'

const SOURCES = [
  {
    value: 'sdr' as const,
    label: 'SDR sweep',
    hint: 'Sub-2 GHz, power per bin',
    icon: <AudioWaveformIcon className="size-4" aria-hidden />,
  },
  {
    value: 'wifi' as const,
    label: 'Wi-Fi occupancy',
    hint: '2.4 / 5 GHz, busy time',
    icon: <WifiIcon className="size-4" aria-hidden />,
  },
]

function SpectrumRoute() {
  const [source, setSource] = useState<Source>('sdr')

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6">
      <h1 className="text-lg font-semibold">Spectrum</h1>
      <p className="text-muted-foreground mt-1 mb-3 text-sm leading-relaxed">
        Two radios, two halves of the band. Both measure energy and identify nothing — a peak or
        a busy channel means something is transmitting, never that it is a drone.
      </p>

      <Segmented
        aria-label="Spectrum source"
        value={source}
        onValueChange={setSource}
        options={SOURCES}
        className="mb-4"
      />

      {/* Unmounted rather than hidden. The sweep panel holds a selected sweep
          and polls for its result; keeping it mounted behind a tab would keep
          that running for a view nobody is looking at. */}
      {source === 'sdr' ? <SpectrumPanel /> : <WifiOccupancyPanel />}
    </div>
  )
}

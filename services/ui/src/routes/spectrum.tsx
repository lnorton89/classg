import { createFileRoute } from '@tanstack/react-router'

import { SpectrumPanel } from '@/features/spectrum/spectrum-panel'

export const Route = createFileRoute('/spectrum')({
  component: SpectrumRoute,
})

function SpectrumRoute() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6">
      <h1 className="text-lg font-semibold">Spectrum</h1>
      <p className="text-muted-foreground mt-1 mb-4 text-sm leading-relaxed">
        Sub-2 GHz band sweeps from the SDR sensor. This is the only sensor that sees aircraft
        flying ELRS or Crossfire, which broadcast no Remote ID at all — but it measures energy
        and identifies nothing.
      </p>
      <SpectrumPanel />
    </div>
  )
}

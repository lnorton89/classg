/**
 * Dev-only scenario switcher.
 *
 * Tree-shaken out of production builds by the `import.meta.env.DEV` guard. It
 * exists because the health-versus-quiet-sky distinction cannot be designed or
 * reviewed without flipping between those states in one click.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Select } from '@/components/ui/select'
import { USE_MSW } from '@/lib/env'

const OPTIONS = [
  { value: 'active', label: 'Mock: active sky' },
  { value: 'quiet-sky', label: 'Mock: quiet sky' },
  { value: 'degraded', label: 'Mock: sensor down' },
  { value: 'down', label: 'Mock: system down' },
] as const

type ScenarioValue = (typeof OPTIONS)[number]['value']

export function MockScenarioSwitcher() {
  const queryClient = useQueryClient()
  const [scenario, setScenario] = useState<ScenarioValue>('active')

  if (!import.meta.env.DEV || !USE_MSW) return null

  return (
    <Select
      aria-label="Mock backend scenario"
      value={scenario}
      options={[...OPTIONS]}
      className="hidden h-7 text-xs lg:flex"
      onValueChange={(value) => {
        setScenario(value)
        void fetch('/__mock/scenario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: value }),
        }).then(() => queryClient.invalidateQueries())
      }}
    />
  )
}

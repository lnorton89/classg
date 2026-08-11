import { createFileRoute } from '@tanstack/react-router'
import { LayoutGridIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { log } from '@/features/logs/log-store'
import {
  hasStoredTrackDetailOrder,
  resetTrackDetailOrder,
} from '@/features/tracks/sortable-detail-grid'
import { SettingRow, SettingsCard } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/tracks')({ component: TrackSettings })

function TrackSettings() {
  const toast = useToast()
  // Read once on mount rather than on every render: this is localStorage, and
  // nothing else in the app writes the key while this page is open.
  const [hasStored, setHasStored] = useState(hasStoredTrackDetailOrder)

  return (
    <SettingsCard
      icon={LayoutGridIcon}
      title="Track detail layout"
      description="The cards on a track's detail page can be dragged into whatever order suits how you read a track. That order is remembered in this browser."
    >
      <SettingRow
        label="Card order"
        hint={
          hasStored
            ? 'A custom order is stored. Resetting restores the default arrangement the next time a track detail page opens.'
            : 'No custom order stored — track detail pages are using the default arrangement.'
        }
      >
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasStored}
            onClick={() => {
              resetTrackDetailOrder()
              setHasStored(false)
              log.action('Track detail card order reset')
              toast.add({ title: 'Card order reset', type: 'success' })
            }}
          >
            <RotateCcwIcon aria-hidden /> Reset card order
          </Button>
        </div>
      </SettingRow>
    </SettingsCard>
  )
}

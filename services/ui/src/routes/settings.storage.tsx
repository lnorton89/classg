import { createFileRoute } from '@tanstack/react-router'

import { StoragePanel } from '@/features/settings/storage-panel'

export const Route = createFileRoute('/settings/storage')({
  component: StorageSettings,
})

function StorageSettings() {
  return <StoragePanel />
}

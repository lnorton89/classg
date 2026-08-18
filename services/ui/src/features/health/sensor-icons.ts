import { AntennaIcon, CloudIcon, RadioIcon, WifiIcon } from 'lucide-react'

import type { SensorKind } from '@/lib/api/types'

// Kept out of components.tsx so that file exports only components: a module
// that mixes the two cannot be hot-swapped by Fast Refresh.
export const SENSOR_ICONS: Record<SensorKind, typeof WifiIcon> = {
  wifi: WifiIcon,
  sdr: RadioIcon,
  ble: AntennaIcon,
  // A cloud, not an antenna. A `net` source is somebody else's receiver reached
  // over the uplink, and an operator reading this page needs to see at a glance
  // that it proves nothing about what *this* unit can hear.
  net: CloudIcon,
}

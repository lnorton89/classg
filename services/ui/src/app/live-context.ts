import { createContext, use } from 'react'

import type { ConnectionState } from '@/lib/api/live'

export interface LiveContextValue {
  connection: ConnectionState
  /** Epoch ms of the last frame of any kind, or null if none yet. */
  lastFrameAt: number | null
  /** Pending reconnect attempt number; 0 when connected. */
  reconnectAttempt: number
}

// Context and hook live here rather than beside the provider so that
// live-provider.tsx exports only its component and stays hot-swappable.
export const LiveContext = createContext<LiveContextValue>({
  connection: 'closed',
  lastFrameAt: null,
  reconnectAttempt: 0,
})

export function useLive(): LiveContextValue {
  return use(LiveContext)
}

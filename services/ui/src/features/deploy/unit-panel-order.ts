import { createCardOrderStore } from '@/components/ui/card-order-store'

export const DEFAULT_UNIT_PANEL_ORDER = ['deployment', 'history', 'watchdog'] as const

export type UnitPanelId = (typeof DEFAULT_UNIT_PANEL_ORDER)[number]

export const unitPanelOrderStore = createCardOrderStore(
  'classg.admin-unit.card-order.v1',
  DEFAULT_UNIT_PANEL_ORDER,
)

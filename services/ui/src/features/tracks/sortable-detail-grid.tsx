import { SortableCardGrid, type SortableCard } from '@/components/ui/sortable-card-grid'

import { trackDetailOrderStore, type TrackDetailCardId } from './track-detail-order'

export type TrackDetailCard = SortableCard<TrackDetailCardId>

export function SortableTrackDetailGrid({ cards }: { cards: TrackDetailCard[] }) {
  return <SortableCardGrid cards={cards} store={trackDetailOrderStore} />
}

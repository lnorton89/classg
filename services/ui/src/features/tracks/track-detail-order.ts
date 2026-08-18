import { createCardOrderStore } from '@/components/ui/card-order-store'

export const DEFAULT_TRACK_DETAIL_ORDER = [
  'evidence',
  'identity',
  'flight',
  'position',
  'operator',
  'signal',
] as const

export type TrackDetailCardId = (typeof DEFAULT_TRACK_DETAIL_ORDER)[number]

export const trackDetailOrderStore = createCardOrderStore(
  'classg.track-detail.card-order.v1',
  DEFAULT_TRACK_DETAIL_ORDER,
)

export const normalizeTrackDetailOrder = trackDetailOrderStore.normalize
export const readStoredTrackDetailOrder = trackDetailOrderStore.read
export const persistTrackDetailOrder = trackDetailOrderStore.persist

/**
 * Forget a dragged layout, for the Tracks settings category.
 *
 * Only clears storage. The grid reads its order once on mount, so an already
 * open track detail keeps the order it is showing until it remounts — which is
 * the honest behaviour: nothing should rearrange itself under the cursor of
 * someone reading a track.
 */
export const resetTrackDetailOrder = trackDetailOrderStore.reset

/** Whether a dragged layout is currently stored, so the reset can be disabled. */
export const hasStoredTrackDetailOrder = trackDetailOrderStore.hasStored

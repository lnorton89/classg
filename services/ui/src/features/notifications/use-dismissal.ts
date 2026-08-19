import { useState } from 'react'

import type { DismissalStore } from './dismissal-store'

/**
 * `[dismissed, dismiss]` for one value in a `DismissalStore`.
 *
 * `dismissed` is true exactly when the last value dismissed in this store
 * still equals `currentValue` — so a caller keyed on, say, a state machine's
 * current kind gets dismissal that clears itself the moment the kind changes
 * to anything else, with nothing to reset by hand. Read once per mount
 * (`useState`'s lazy initializer) rather than kept in sync live: nothing
 * else writes this key while the component holding it is on screen, the same
 * assumption `TrackSettings` makes about its own localStorage read.
 */
export function useDismissal(
  store: DismissalStore,
  currentValue: string,
): [dismissed: boolean, dismiss: () => void] {
  const [dismissedValue, setDismissedValue] = useState(store.read)

  function dismiss() {
    store.dismiss(currentValue)
    setDismissedValue(currentValue)
  }

  return [dismissedValue === currentValue, dismiss]
}

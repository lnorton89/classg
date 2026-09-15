/**
 * "The operator has been told this once" — remembered per browser, forever.
 *
 * Several screens carry a standing band that teaches something true and
 * finite: what the four track states mean, what the map's brightness encodes.
 * They are right the first time and furniture by the tenth, and on the Flights
 * page the state key was pushing the history it explains below the fold on
 * every single visit.
 *
 * localStorage rather than the sessionStorage `dismissal-store.ts` uses, and
 * the difference is the whole point. That store holds "I have seen THIS
 * occurrence" for a banner whose content tracks the system's state, where a
 * dismissal outliving the tab would suppress a genuinely new event. This one
 * holds "I know what this means", which does not stop being true when the tab
 * closes.
 *
 * Its own module rather than living beside the banner components: a file that
 * exports both a hook and components breaks fast refresh for everything in it.
 */
import { useState } from 'react'

/** Namespaced like every other key this app writes — see `classg.preferences`. */
function storageKey(id: string): string {
  return `classg.taught.${id}`
}

function readTaught(id: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(storageKey(id)) === '1'
  } catch {
    // Private browsing and similar. Showing the explainer again is a far
    // smaller problem than a page that will not render.
    return false
  }
}

function writeTaught(id: string, taught: boolean): void {
  try {
    if (taught) window.localStorage.setItem(storageKey(id), '1')
    else window.localStorage.removeItem(storageKey(id))
  } catch {
    /* the dismissal still applies for this mount */
  }
}

export interface Teaching {
  dismissed: boolean
  dismiss: () => void
  show: () => void
}

/**
 * Read once per mount, as `useDismissal` does: nothing else writes this key
 * while the component holding it is on screen.
 */
export function useTeaching(id: string): Teaching {
  const [dismissed, setDismissed] = useState(() => readTaught(id))

  return {
    dismissed,
    dismiss() {
      writeTaught(id, true)
      setDismissed(true)
    },
    show() {
      // Clears the stored dismissal rather than only revealing it for this
      // mount: someone who pressed "?" wants it back, and having it vanish
      // again on the next navigation reads as a bug rather than as a setting.
      writeTaught(id, false)
      setDismissed(false)
    },
  }
}

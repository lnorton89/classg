/**
 * "The operator already saw and closed this" — remembered across navigation
 * and the app's own self-reload, forgotten once the tab actually closes.
 *
 * `SkyStateBanner` used to keep its dismissed state in a plain `useState`.
 * That component only exists on the Live route, so leaving `/` and coming
 * back unmounted and remounted it — and "Quiet sky", dismissed thirty seconds
 * earlier, was back the instant the operator returned. sessionStorage
 * survives both that remount and the periodic self-reload `AppUpdateBanner`
 * triggers, and clears on its own when the tab is gone, which is the right
 * lifetime for "already seen" — as opposed to localStorage's "seen ever",
 * which would let a dismissal from three days ago silently suppress a
 * genuinely new occurrence.
 *
 * One factory rather than one hand-rolled copy per banner.
 *
 * Not to be confused with `components/ui/teaching-banner.tsx`, which is
 * localStorage and means "I know what this means". This one is sessionStorage
 * and means "I have seen this occurrence": the difference matters, because a
 * sky-state dismissal that outlived the tab would let a three-day-old "Quiet
 * sky" suppress a genuinely new one.
 */
export interface DismissalStore {
  /** The value most recently dismissed in this group, or null if none / storage unavailable. */
  read: () => string | null
  /** Record `value` as the dismissed one, replacing whatever was dismissed before it. */
  dismiss: (value: string) => void
}

export function createDismissalStore(storageKey: string): DismissalStore {
  return {
    read() {
      if (typeof window === 'undefined') return null
      try {
        return window.sessionStorage.getItem(storageKey)
      } catch {
        return null
      }
    },
    dismiss(value) {
      try {
        window.sessionStorage.setItem(storageKey, value)
      } catch {
        // Storage can be unavailable in privacy modes; the dismissal still applies for this mount.
      }
    },
  }
}

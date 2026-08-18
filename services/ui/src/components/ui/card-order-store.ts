/**
 * A drag-to-reorder layout, remembered per browser.
 *
 * One factory rather than one copy per entity that gets reorderable cards:
 * this used to be track-detail-specific (read/normalize/persist/reset/
 * hasStored, each hand-written against one localStorage key), and a second
 * copy for a different card grid would have been the same duplication the
 * ClassG mark and the artefact list already were.
 */
export interface CardOrderStore<Id extends string> {
  storageKey: string
  defaultOrder: Id[]
  normalize: (value: unknown) => Id[]
  read: () => Id[]
  persist: (order: Id[]) => void
  reset: () => void
  /** Whether a dragged layout is currently stored, so a reset control can disable itself. */
  hasStored: () => boolean
}

export function createCardOrderStore<Id extends string>(
  storageKey: string,
  defaultOrder: readonly Id[],
): CardOrderStore<Id> {
  const defaults = [...defaultOrder]
  const expected = new Set<string>(defaults)

  function normalize(value: unknown): Id[] {
    if (!Array.isArray(value)) return [...defaults]
    if (value.length !== expected.size || value.some((item) => !expected.has(String(item)))) {
      return [...defaults]
    }
    return value as Id[]
  }

  return {
    storageKey,
    defaultOrder: defaults,
    normalize,
    read() {
      if (typeof window === 'undefined') return [...defaults]
      try {
        return normalize(JSON.parse(window.localStorage.getItem(storageKey) ?? 'null'))
      } catch {
        return [...defaults]
      }
    },
    persist(order) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(order))
      } catch {
        // Storage can be unavailable in privacy modes; dragging should still work for this session.
      }
    },
    reset() {
      try {
        window.localStorage.removeItem(storageKey)
      } catch {
        /* nothing stored to forget */
      }
    },
    hasStored() {
      try {
        return window.localStorage.getItem(storageKey) !== null
      } catch {
        return false
      }
    },
  }
}

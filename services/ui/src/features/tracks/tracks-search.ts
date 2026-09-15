/**
 * The Flights list's URL contract.
 *
 * Lives beside the feature rather than in the route file so that anything
 * building a link INTO the list -- the header's search box, most of all --
 * can use the same schema the page validates with, instead of hand-writing
 * `?q=` and discovering the key was renamed only when a link stops narrowing
 * anything. `routes/tracks/index.tsx` re-exports it, which is where the route's
 * own `validateSearch` reads it from.
 *
 * The rule the schema exists to keep: a stale or hand-edited URL must degrade
 * to the default view, never throw. `validateSearch` runs before the component,
 * so a rejected value takes the page down rather than one control -- hence
 * `.optional().catch(undefined)` on every key, and absent rather than empty
 * when unset.
 *
 * `since` holds the window CHIP, not a timestamp. A shared link to "the last
 * 7 days" should mean seven days from when it is opened; a link carrying an
 * absolute instant would quietly become a link to a fixed historical window.
 */
import { z } from 'zod'

import { FLIGHT_SORT_VALUES } from './flight-metrics'
import { WINDOW_CHIPS } from './flight-time'

export const tracksSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  since: z.enum(WINDOW_CHIPS).optional().catch(undefined),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  vendor: z.string().optional().catch(undefined),
  // The eight detection classes, spelled out: DETECTION_CLASS_ORDER is an
  // array rather than a tuple, and z.enum needs the literal union.
  evidence: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']).optional().catch(undefined),
  operator: z.enum(['yes', 'no']).optional().catch(undefined),
  group: z.enum(['aircraft', 'none']).optional().catch(undefined),
  sort: z.enum(FLIGHT_SORT_VALUES).optional().catch(undefined),
  /**
   * Which rendering of the same flights is on screen. `lanes` is what used to
   * be the Timeline page: one bar per flight on a band of time, over the same
   * window and the same filters the list is using. It is a view, not a page,
   * because it was answering the list's question with a second copy of the
   * list's state -- and the two drifted, so /timeline sent you somewhere that
   * had forgotten which day you were looking at.
   */
  view: z.enum(['lanes', 'list']).optional().catch(undefined),
})

export type TracksSearch = z.infer<typeof tracksSearchSchema>

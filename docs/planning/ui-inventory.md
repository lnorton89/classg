# UI inventory

Status: written September 15 2026 as step 1 of Workstream A in
[ui-upgrade-plan.md](ui-upgrade-plan.md), and brought forward the same day
through Workstreams B (app shell, search, teaching banners) and C (Live,
Sensors, Settings). It records what every route and panel is built from, so a
later pass can find a pattern without re-reading the tree.

Rows marked ✅ were migrated onto the shared components by Workstream A. Rows
marked — were left for a later workstream; the reason is in the notes. The
sections after "Sensors — what changed" record B and C.

## Routes

`services/ui/src/routes`. "Frame" is `PageContainer` unless noted.

| Route                                                                               | Header                                | Frame                 | Cards                                      | Notes                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------- | --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (`index.tsx`)                                                                   | none — full-bleed map                 | none, deliberately    | `StatTile` ×4, `ContactsPanel`             | Live map fills the viewport; `PageContainer` is withheld on purpose. Map holds its own height (`absolute inset-0` inside a `min-h-[55dvh]` panel). |
| `/tracks/`                                                                          | `PageHeader` + 3 × `SectionHeader`    | ✅                    | tables, histogram, filter bar              | `TrackStateKey` is a one-time `TeachingBanner` now (`useTeaching('track-state-key')`). Also absorbed the Timeline as `?view=lanes`.                |
| `/tracks/$trackId`                                                                  | hand-rolled `<header>` with back link | ✅                    | `MetricStrip` ✅, map, profiles, receivers | Six-tile strip extracted to `components/ui/metric-strip.tsx`. Rest is Workstream C.                                                                |
| `/timeline`                                                                         | none — redirect                       | —                     | —                                          | Redirects to `/tracks?view=lanes`. `TimelinePanel` and its test are deleted; the route file stays so bookmarks and `routeTree.gen.ts` still work.  |
| `/sensors`                                                                          | `PageHeader` ✅                       | ✅                    | list-detail; `SensorHealthCard` ✅         | Fully restructured — see "Sensors" below. Its captures pane is gone; the nav rail keeps a count linking to `/captures`.                            |
| `/logs`                                                                             | `PageHeader`                          | ✅                    | `LogsView`                                 | Level chips are label chips, not status; stay on `Badge`.                                                                                          |
| `/admin`                                                                            | `PageHeader`                          | ✅                    | 3 plain cards, fixed order                 | ✅ `SortableCardGrid` retired; `unit-panel-order.ts` deleted with it.                                                                              |
| `/settings` (layout)                                                                | `PageHeader` + nav + `ScopeNote`      | ✅                    | `SettingsCard` per topic                   | ✅ 12 sub-pages, one shared explanation per group — see "Settings groups" below.                                                                   |
| `/settings/about`                                                                   | `SettingsCard`s                       | inherited             | host readings, telemetry chart             | Read-only; nothing on it saves.                                                                                                                    |
| `/settings/calibration`                                                             | `SettingsCard`s + `Card`s             | inherited             | `ChannelPlanView` (read-only)              | ✅ The weighted editor is gone — see "Settings groups".                                                                                            |
| `/settings/{general,map,tracks,notifications,data,logs,sensors,appearance,storage}` | `SettingsCard`                        | inherited             | —                                          | ✅ Field paragraphs reduced to one-line hints; the rest behind `Why`.                                                                              |
| `/docs` (layout)                                                                    | tree nav, no `PageHeader`             | own `max-w-5xl` frame | —                                          | Layout is a file tree; a page header would duplicate the doc title.                                                                                |
| `/docs/$docId`                                                                      | hand-rolled card header               | own `max-w-5xl` frame | `Card` per section                         | ✅ eyebrow now carries the area.                                                                                                                   |
| `/captures/$captureId`                                                              | hand-rolled `<h1>` + back link        | ✅                    | `Card` ×2                                  | ✅ moved onto `PageHeader` with an eyebrow back link; the Capture card is the page's one primary.                                                  |
| `/captures/`                                                                        | `PageHeader`                          | ✅                    | `CaptureHistory`                           | ✅ a real page, not a redirect to `/sensors#captures`. The only home of the recordings list.                                                       |
| `/spectrum`                                                                         | `PageHeader`                          | ✅                    | `SpectrumPanel`                            | A page again rather than a panel inside the sdr-0 card; the sensor detail links to it.                                                              |
| `/config`, `/docs/`, `/settings/`, `/timeline`                                      | redirects only                        | —                     | —                                          | No UI. Kept because the URLs are in bookmarks and the operator guide.                                                                              |

## Status vocabulary

Everything below is now one component: `StatusPill`
(`components/ui/status-pill.tsx`), tones `ok | warn | down | info | muted`.
`Badge` keeps only `default | outline | muted` — the health tones were removed
from it so a future status cannot drift back onto a second primitive.

| Was                                                                                                | Where                                                                     | Now                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `Badge variant="ok\|down"` healthy/unhealthy                                                       | `features/health/components.tsx`                                          | ✅ `StatusPill`                                              |
| header health pill (own `TONE_CLASS`/`TONE_DOT` maps, tone `unknown`)                              | `features/health/status-button.tsx`                                       | ✅ shares `statusPill()` + `STATUS_DOT`; `unknown` → `muted` |
| `TrackStateBadge` (CONFIRMED/COASTING/CLOSED/other)                                                | `features/tracks/evidence.tsx`                                            | ✅ `StatusPill`; TENTATIVE now `info`                        |
| `AircraftFlagBadge` (known/watch/ignore)                                                           | `features/tracks/aircraft-label.tsx`                                      | ✅ `StatusPill`                                              |
| watchdog: needs attention / repairing / answering / down / on the bus / absent                     | `features/deploy/watchdog-panel.tsx`                                      | ✅ `StatusPill`                                              |
| deploy run result (deployed/failed/rebuilt)                                                        | `features/deploy/deploy-history.tsx`                                      | ✅ `StatusPill`                                              |
| artefact state (rebuilt/behind/failed/current)                                                     | `features/deploy/artefact-list.tsx`                                       | ✅ `StatusPill`                                              |
| deployment: deploying / update available / CI result / auto-deploy on-off                          | `features/deploy/deployment-panel.tsx`                                    | ✅ `StatusPill`                                              |
| capture state                                                                                      | `features/captures/sensor-captures.tsx`, `routes/captures/$captureId.tsx` | ✅ `StatusPill`                                              |
| sweep state                                                                                        | `features/spectrum/spectrum-panel.tsx`                                    | ✅ `StatusPill`                                              |
| hook rule disabled, delivery status                                                                | `features/hooks/hooks-panel.tsx`                                          | ✅ `StatusPill`                                              |
| account disabled, "this browser"                                                                   | `features/auth/admin-users.tsx`                                           | ✅ `StatusPill`                                              |
| recording indicator                                                                                | `features/monitoring/recording-indicator.tsx`                             | ✅ `StatusPill` (`lg`, pill-shaped)                          |
| notification level                                                                                 | `features/notifications/notifications-drawer.tsx`                         | ✅ `StatusPill`                                              |
| sky-state banner (own tone maps)                                                                   | `features/health/components.tsx`                                          | — banner, not a pill; tones already match the token set      |
| log level chip, `rule.event`, `rule.action`, "you", "SSO", "ADS-B correlated", manned-traffic chip | logs, hooks, auth, tracks, map                                            | — label chips, not status; stay on `Badge`                   |

## Key-value lists

| Component                       | Where                                                                                                                        | Notes                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DataList` / `DataRow`          | `components/ui/misc.tsx`                                                                                                     | The canonical pair. `DataRow` already carried `data-density-row`.                                              |
| `KeyValueGroup` / `KeyValueRow` | `components/ui/key-value-group.tsx` (new)                                                                                    | `DataList` plus a group heading and an optional inline bar per row, for per-channel / per-receiver breakdowns. |
| hand-rolled `<dl>` + `DataRow`  | `routes/sensors.tsx` `SystemFooter`, `features/health/components.tsx`, `routes/captures/$captureId.tsx`, `features/deploy/*` | Migrated where Workstream A touched the page; the rest read fine as flat lists under five rows.                |
| `PreviewPanel` / `PreviewRow`   | `features/settings/controls.tsx`                                                                                             | A format preview, not a data dump — left alone.                                                                |

## Empty / loading / error states

One set, all in `components/ui/misc.tsx`: `EmptyState`, `Skeleton`, `ErrorState`
(new), plus `Alert` for in-flow messages.

| State   | How it was done                                               | Count                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| empty   | `EmptyState`                                                  | 15 call sites, already consistent                                                                                                                                                       |
| loading | `Skeleton`                                                    | 17 call sites                                                                                                                                                                           |
| loading | literal "Loading…" text                                       | `components/layout/route-pending.tsx`, `features/map/live-map.tsx`, `routes/tracks/index.tsx`                                                                                           |
| error   | `Alert tone="error"` inline                                   | 12 call sites — correct for a failed _action_, left alone                                                                                                                               |
| error   | ad-hoc `<p className="text-down">` where a whole panel failed | `features/settings/hosts/host-history.tsx` ✅ `ErrorState`; `features/health/status-button.tsx` — left as a line, it is one row inside a popover and `ErrorState`'s `p-8` would not fit |

Map sizing: `LiveMap` takes its height from the caller and overlays its loading
line absolutely, so it never reflows — on `/` the caller is a `ResizableSplit`
panel (desktop) or a `min-h-[55dvh] flex-1` box (mobile), and both hold their
size from first paint. The exception was `TrackMap`'s no-positions fallback at
`h-48` against a map at `h-[22rem] sm:h-[26rem] lg:h-[32rem]`: whether a flight
has a path is not known until its detections load, so that placeholder became a
32rem map and moved the whole page under it. ✅ Fixed to the same heights.

## Density

`Appearance → Density` writes `document.documentElement.dataset.density`.
`styles.css` acts on it:

| Selector                                             | Effect                                         |
| ---------------------------------------------------- | ---------------------------------------------- |
| `:root[data-density='compact'] :is(td, th)`          | table cell padding → `--row-py`                |
| `:root[data-density='compact'] [data-density-row]`   | `DataRow` / `KeyValueRow` padding              |
| `:root[data-density='compact'] [data-density-group]` | ✅ new — group heading and inter-group spacing |

Touch targets (`min-h-11` buttons, `Switch`, nav rows) are deliberately outside
all of it.

## Shared components after Workstream A

| Component                                       | File                                | Notes                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader` / `SectionHeader`                  | `components/layout/page-header.tsx` | Gained an `eyebrow` slot for a breadcrumb or back link.                                                                                                                                                                                                           |
| `Why`                                           | `components/ui/why.tsx`             | `<details>` disclosure for the rationale paragraphs that used to sit in page descriptions.                                                                                                                                                                        |
| `Card` weights                                  | `components/ui/card.tsx`            | `weight="primary" \| "secondary" \| "plain"`. Omitted = today's look, so nothing changes until a page opts in. The weight is also written to `data-card-weight`, so a page can be audited for a second primary. Opted in so far: Sensors, `/captures/$captureId`. |
| `StatusPill`                                    | `components/ui/status-pill.tsx`     | Also exports `statusPill()` and `STATUS_DOT` for the header button.                                                                                                                                                                                               |
| `MetricStrip`                                   | `components/ui/metric-strip.tsx`    | The six-tile strip, extracted from the track detail page.                                                                                                                                                                                                         |
| `KeyValueGroup`                                 | `components/ui/key-value-group.tsx` | Grouped `DataList` with optional inline bars.                                                                                                                                                                                                                     |
| `EmptyState`, `Skeleton`, `ErrorState`, `Alert` | `components/ui/misc.tsx`            | One set.                                                                                                                                                                                                                                                          |

## Sensors — what changed

The reference case from the plan's "What hierarchy means here":

1. `MetricStrip` of six, chosen per sensor kind by
   `features/health/sensor-summary.ts`. Wi-Fi: heard, drone detections, last
   five minutes, listening share, lost to hopping, last heartbeat. SDR:
   messages read, parsed, aircraft heard, parse errors, uptime, last heartbeat.
   A kind this build has never seen still gets a strip.
2. `KeyValueGroup` with inline bars for dwell share, beacons per channel and
   drone hits per channel (`features/health/sensor-breakdowns.ts`). Bars are
   scaled to the group's own peak, and every channel is listed — the old comma
   list stopped at six with "+3 more".
3. Build-limitation notes ("Restart unavailable — systemctl is not available in
   the API runtime", "Capture is not implemented for SDR sensors yet") reduced
   from two permanent error-styled boxes to one muted line.
4. Everything else — the full grouped `detail` map — behind an **All counters
   (n)** disclosure. Nothing is dropped: a key a future sensor invents still
   lands in "Other" exactly as before, and `groupSensorDetail` gained an `omit`
   argument so a reading the strip promoted is not also printed below it.
5. The survey note was printed twice (once as the `Survey` group's "Survey
   note", once by the occupancy panel); the occupancy panel owns it now.
6. The selected sensor's card is the page's one `weight="primary"`.

## Contrast pass

Both themes, muted text and every tone, measured against the ground each is
actually read on — for a pill that is its own 15% tint, not the card.

One token moved: light-theme `--warn` from `oklch(0.55 0.14 62)` to `0.50`.
At 0.55 it was 4.44:1 on `bg-warn/15` at 13px, just under the line; it is 5.2:1
now. Everything else already cleared 4.5:1, and dark-theme muted text sits at
8.3:1 on card and 8.9:1 on the page ground. Fixed in `styles.css`, not per
component — nothing overrides a tone locally.

## Explanatory prose moved behind `Why`

| Page      | Was                                                                                        | Now                                                   |
| --------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Sensors   | three standing lines in the nav rail about what zero detections means                      | `Why label="What does zero detections mean?"`         |
| Settings  | two-sentence header; second sentence explained a distinction the nav already draws         | `ScopeNote` per page (the `Why` it replaced is gone)  |
| Event log | one long header sentence enumerating every event kind plus the not-the-system's-log caveat | one line + `Why`                                      |

Every other page's description was already one line. Workstream C took the
pattern down a level, from page descriptions into settings groups and fields —
see "Settings groups" below.

## Navigation model (Workstream B)

`components/layout/nav-items.ts` is the single list, rendered by the desktop
`side-rail.tsx` and the phone's `bottom-tabs.tsx` + More sheet. Header chrome
(`app-shell.tsx`) keeps the status cluster, the bell and `global-search.tsx`.

| Entry          | Route       | Group    | On the phone bar |
| -------------- | ----------- | -------- | ---------------- |
| Live           | `/`         | watch    | ✅               |
| Flights        | `/tracks`   | watch    | ✅               |
| Sensors        | `/sensors`  | watch    | ✅               |
| Spectrum       | `/spectrum` | watch    | More             |
| Captures       | `/captures` | watch    | More             |
| Event log      | `/logs`     | watch    | More             |
| Settings       | `/settings` | manage   | More             |
| Administration | `/admin`    | manage\* | More             |

\* admin role only. Two rules hold the list together and are worth not
relearning: **one destination, one entry** — the router stamps
`aria-current="page"` on any active `Link` and that stamp beats anything the
caller passes, so two entries sharing a route light both; and **no search
params in `to`** — `isNavItemActive` matches on path prefix alone, which is why
Captures had to become a route rather than `/sensors?view=captures`, and why
Timeline is not an entry at all (it is Flights' own `?view=lanes`).

## Search-param schemas

Every list and detail selection is URL state. `validateSearch` runs *before* the
component, so each schema is `.optional().catch(undefined)` per key: a stale
link or a hand-edited query degrades to the default view instead of taking the
page down. Covered by `routes/search-params.test.ts` and
`routes/tracks/tracks-search.test.ts`.

| Route       | Schema                     | Keys                                                                                       |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `/tracks/`  | `features/tracks/tracks-search.ts` | `q`, `since`, `day`, `vendor`, `evidence`, `operator`, `group`, `sort`, `view` (lanes\|list) |
| `/sensors`  | `sensorsSearchSchema`      | `sensor`                                                                                    |
| `/logs`     | `logsSearchSchema`         | `level`, `source`, `q`                                                                      |
| `/spectrum` | `spectrumSearchSchema`     | `band`                                                                                      |
| `/admin`    | `adminSearchSchema`        | `section`                                                                                   |

`/sensors` lost `view=captures` in Workstream C: `/captures` is a page, so the
pane behind that key was a second copy of one list at a URL only the Sensors
page understood. The key is out of the schema; a stale bookmark lands on the
first sensor.

## Teaching banners

`components/ui/teaching-banner.tsx` + `use-teaching.ts`. A band that teaches
something true and finite is right the first time and furniture by the tenth,
so dismissal is remembered in `localStorage` under `classg.taught.<id>` —
deliberately **not** the `sessionStorage` `dismissal-store.ts` uses, which holds
"I have seen this occurrence" for a banner whose content tracks live state.

| Id                    | Where                     | Teaches                                  |
| --------------------- | ------------------------- | ---------------------------------------- |
| `track-state-key`     | `routes/tracks/index.tsx` | what the four track states mean           |
| `map-legend`          | `features/map/legend.tsx` | what the map's symbols encode             |
| `map-legend-footer`   | `features/map/legend.tsx` | the footnote under it                     |

The hook lives in its own module rather than beside the components: a file
exporting both a hook and a component breaks fast refresh for everything in it.

## Deleted in B and C

Nothing here has a replacement that needs finding; each row is a pattern that
was retired rather than moved.

| File                                       | Why                                                              |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `components/ui/sortable-card-grid.tsx`     | drag-to-reorder retired for fixed hierarchies                    |
| `components/ui/card-order-store.ts`        | its persistence                                                  |
| `features/deploy/unit-panel-order.ts`      | the admin page's copy of the same                                |
| `features/tracks/sortable-detail-grid.tsx` (+ test), `track-detail-order.ts` | the track detail's copy |
| `features/tracks/rssi-chart.tsx`           | superseded by the flight profile lanes                           |
| `features/timeline/timeline-panel.tsx` (+ test) | Timeline became `/tracks?view=lanes`                        |
| `routes/sensors.tsx` `ListEntry`           | the captures entry it drew is a link now                         |

`@dnd-kit/core`, `@dnd-kit/sortable` and `@dnd-kit/utilities` went with the
drag-to-reorder grids — `npm uninstall`, so `package-lock.json` stays
installable by the `npm ci` CI runs.

## Settings groups (Workstream C)

The problem was not that the twelve sub-pages explained themselves. It was that
they explained themselves *per field*: a paragraph under every label, which put
Save several screens from the thing it saves and made nothing scannable.

Three moves, applied everywhere:

1. **Scope, once per page.** `ScopeNote` in `routes/settings.tsx` reads the
   active category out of `SETTINGS_CATEGORIES` and states "This browser" or
   "This receiver" at the top of the content pane. The page header's `Why` and
   Calibration's standing "these change the receiver, not your view" banner
   both went, because both said this less precisely.
2. **One explanation per group.** `SettingsCard` and `SettingsGroup` each gained
   `description` (the sentence that applies to every control under it) and `why`
   (a `Why` disclosure for the reasoning behind a default, or the failure it
   prevents). What is left on a field is a one-line `hint`, or the registry's
   own `doc` string.
3. **Save at the foot of the group it writes**, with three visible states:
   disabled when clean, "Unsaved changes" beside it when dirty, and a saved
   confirmation that distinguishes *stored and in effect* from *stored, still
   running the old value* — the API serves the running configuration, so a saved
   value does not come back in the refetch.

| Page          | Groups                                                                     | Save |
| ------------- | -------------------------------------------------------------------------- | ---- |
| General       | Units, Time                                                                | none — instant apply |
| Appearance    | Display, Field use                                                         | none |
| Notifications | What appears in the drawer, Severity, Sound                                | none |
| Live map      | Live map                                                                   | none |
| Tracks        | Flight path                                                                | none |
| Sensors       | Sensors                                                                    | none |
| Logs          | Event log                                                                  | none |
| Calibration   | Receiver position, Expected sensors, Timing and limits, Channel plan, Fusion confidence weights | one per group, except the read-only plan |
| External data | Network ADS-B, Terrain elevation, Offline registries, Vector basemap (read-only) | one per group |
| Storage       | Disk (read-only), The pilot's position, Retention → Schedule               | one per editable group |
| About         | Build, Status, Host, Runtime                                               | none — read-only |

"Timing and limits" is the group that holds `sensors.stale_after`,
`fusion.track_ttl`, `fusion.resume_within`, `fusion.max_history`,
`spectrum.sweep_timeout` and `capture.analyze_timeout`. No setting key, kind or
behaviour changed anywhere in this pass — it is layout and copy.

### The channel plan is read-only now

It was a weight-per-channel editor with a Save, under a banner saying the Save
reached no running receiver. That was true: the hopper reads its channel file
from disk at startup and sensors subscribe to nothing (ADR-0002), so there is no
path from the database to a running radio — not even across a restart, which
re-reads the same file. An editor disclaimed by the paragraph above it has every
affordance of a thing that works and none of the effect.

`ChannelPlanView` replaces it with the comparison an operator can actually act
on:

- **Loaded by the receivers** — the plan file each Wi-Fi sensor reports on its
  own heartbeat (`detail.plan`), plus `plan_fallback` / `plan_widened_for_peer`
  when a radio widened beyond it. A measurement, not a guess.
- **Recorded here — intended, not applied** — `GET /config/channels` rendered as
  figures, with **Copy as YAML** in the exact shape
  `config/channels-*.yaml` takes.
- A `Why` naming the three files and which receiver reads which.

Deliberately not built: a button that writes those files. It needs a write path
from the API container into each sensor's config directory and a restart of a
detector that is currently watching the sky; the honest version of that is a
deployment step, not a settings page.

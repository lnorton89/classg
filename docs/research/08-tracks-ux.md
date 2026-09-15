# 08 — Finding one flight among many: Tracks list and track detail

Status: research, September 2026. Phases 1 to 3 below were implemented the
same month; the fusion change that stops a flight splitting at a reception gap
is `ResumeWithin` in `services/fusion/track.go`. The `summary` object on the
track schema remains optional and unimplemented.

## The problem, stated precisely

The Tracks page is a list of **flights** (fusion sessions) rendered as if it were a
list of **drones**. On the current unit, 29 closed tracks are dominated by one
serial (`1581F3YTBJ9H003045J0` fills 15 of the first 17 rows). Every column that
is meant to distinguish rows fails to:

| Column | Why it doesn't help you find a flight |
|---|---|
| Identity (serial + MAC) | Identical on most rows. The widest column carries the least information. |
| State | Always `CLOSED` in the closed table. Dead column. |
| Confidence | Always 60 % for a class-A-only track (noisy-OR of one 0.6 weight). Dead column. |
| Evidence `A×2302` and Detections `2302` | Same number twice. |
| Peak RSSI | Real signal, but not how anyone remembers a flight. |
| Last seen | The only useful discriminator, and it is the *end* of the flight. |
| Position | A raw lat/lon pair. Nobody recognises a flight from six decimal places. |

What a person actually uses to recognise a flight is: **when it happened, how
long it lasted, the shape of the path, how far it went, and whether the pilot
was located**. None of those are on the row, even though the list payload
already carries `first_seen`, a `history[]` of up to 4096 positions
(`services/fusion/track.go:86`) and `operator`. The page also has no time
navigation, no URL state (filters and sort reset on Back), and the search box
only matches identity strings. Separately, `partitionTracks` produces an
`unidentified` bucket that the Tracks route never renders
(`routes/tracks/index.tsx:23`), so class-C/D/H-only tracks are invisible here.

The detail page has the inverse problem. The map, which is the thing you opened
the track for, is below the fold. Above it sit two cards that say the same thing
on every class-A track ("60 %, 1 − (1 − 0.60) = 0.600") and a card that repeats
the header. Six equally weighted cards plus drag-to-reorder is a workaround for
the page having no hierarchy. The signal card never renders its receiver
breakdown because the GraphQL query omits `receivers`
(`lib/api/graphql.ts:43–71`). And there is no way to get from one flight of an
aircraft to its other flights.

## What comparable products do

**Dedrone DroneTracker (3.1 manual, alert list).** Columns are *Thumbnail, Time,
Duration, Source (sensors), Flag, Alerting zones, Manufacturer, Model, Protocol,
SSID*. Filters: date range, minimum duration, sensor, sensor type, flag, zone,
manufacturer, model, protocol, SSID. Operators categorise alerts with flags and
comments, and the report is generated from whatever filter is active. The
detail view is: alert options, alert details, categorisation, then replay +
map + per-sensor sources with GPX export. DedroneTracker.AI 6.0 adds automatic
*Groups* and manual *Events* so related alerts replay together, and analytics
(alerts by hour/day, heatmap, by sensor, by manufacturer).

**DJI AeroScope AMS.** *Flight History* is a keyword search (flight number,
device ID) over records with export and a *Track Playback* button per record;
*Statistical Report* is a time range → charts and a heat map of detection
frequency.

**Flightradar24.** The aircraft is the page; flights are rows under it (date,
route, times, flight time, playback link). Identity is stated once, then each
row is only the things that differ between flights.

**Strava activity feed.** One card per activity: title + time, three key stats
chosen per activity type, and a map thumbnail of the route. The thumbnail is
what makes a list of near-identical runs scannable — the shape is a fingerprint.

**Kibana Discover.** A histogram of records over time sits above the results
table; brushing the histogram sets the time range. Active filters are pills.

**Remote ID receiver apps (Drone Scanner, DroneScout).** List + map, drone
labelling/favourites, searchable history, CSV export.

**Generic table guidance** (Pencil & Paper, Eleken, saasui.design, NN/g):
don't repeat the title in every cell; group rows under headers; keep the
identifying column sticky; default sort recent-first; offer a density toggle;
use expandable rows or a quick-view panel when rows are similar and users are
scanning; show facet counts so filters never return zero results; prefer batch
filtering with an Apply for goal-directed users, live filtering for
exploration.

The common thread: **identity is stated once; each row is a session described
by time, duration, shape and extent; a time histogram and a thumbnail carry
most of the scanning work.**

## Proposal: Tracks list

### 1. Group by aircraft, state identity once

Default view groups tracks by serial (fallback: primary MAC), Linear-style, with
collapsible group headers:

```
▾ 1581F3YTBJ9H003045J0   dji · multirotor   26 flights · Sep 4 – Sep 15   [Label…]
    Sep 15  09:05   0:40    ~~~   0.4 km   —      16   −83 dBm   op ✓
    Sep 14  23:16   9:22    ~~~   1.1 km   64 m   2302 −37 dBm   op ✓
    …
▸ 1581F8LQC25BD0026JYM   dji                1 flight  · Sep 6
▸ 1581F9DEC259E0296040   dji                2 flights · Sep 5 – Sep 6
```

"Group: Aircraft | None" toggle in the toolbar. Ungrouped view keeps a sticky
identity column but renders it muted when it equals the row above.

### 2. Replace dead columns with flight columns

| Keep | Add | Drop from the closed table |
|---|---|---|
| Detections, Peak RSSI | **Start** (local date + time), **Duration** | State (always CLOSED) |
| Evidence chips → tooltip on Detections | **Path thumbnail** (mini polyline from `history[]`, sensor at origin) | Confidence (identical across class-A tracks; keep for the active table) |
| | **Max range** from receiver position (`map.receiver_position` in settings, `features/map/geo.ts`) | Raw Position (moves into the thumbnail tooltip) |
| | **Max height AGL** when `height_agl_m` exists | |
| | **Operator located** (✓ / —), gated as today | |

Sort by any of these; default `Start desc`.

### 3. Time navigation above the table

A flights-per-day histogram for the retention window (30 days default), each
bar clickable to filter to that day; quick chips `Today · 24 h · 7 d · 30 d ·
All`. This reuses the API's `since` (and needs an `until`). The Timeline page
keeps its lane view; the two should share the same window control and, longer
term, become one "Flights" page with a lanes/list toggle.

### 4. Filters as chips with counts, in the URL

Search stays (identity strings). Add facet chips: Vendor, Evidence class,
Operator located, Duration ≥, Detections ≥. Show counts per option. Persist
`q`, `since`, `until`, `vendor`, `evidence`, `group`, `sort` as route search
params using the `validateSearch` + `.catch(undefined)` + `replace: true`
convention already used by `routes/sensors.tsx:56` and `routes/admin.tsx:32`,
so Back returns to the same view and a URL can be shared.

### 5. Quick view without leaving the list

Clicking a row (not the serial link) expands it inline: a 300 px map of the
full path with operator marker, the summary strip from the detail page, and
"Open flight →". This is the Pencil & Paper "expandable row" pattern and is
what makes reviewing ten flights of the same aircraft a two-minute job instead
of ten page loads.

### 6. Labels per aircraft

A free-text label and a flag (`known`, `watch`, `ignore`) stored per serial,
shown in place of the serial everywhere. "Neighbour's Mini 4 Pro" is how an
operator thinks about `1581F3YTBJ9H003045J0`. This is the Dedrone flag/comment
and Drone Scanner label feature. Receive-only is unaffected; it is a note, not
an action. Needs an API table + endpoint; it is the one item here that is not
UI-only.

## Proposal: Track detail

Replace the six-card grid with a fixed hierarchy. Drop drag-to-reorder; it
exists to compensate for the missing hierarchy and its localStorage store can
go with it.

1. **Header** — label or serial, vendor · model hint · UA type, state badge,
   flight window ("Sep 14, 11:16:58 – 11:26:20 PM"). Actions: Share, Export
   CSV/GeoJSON, Flag/Label.
2. **Summary strip** — Duration · Max range from sensor · Max height AGL · Max
   speed · Detections / path points · Operator distance from sensor. These are
   the point of the page, so they earn the big-number treatment.
3. **Map, full width** — path coloured by time (or altitude), operator marker,
   receiver position with range rings, and a **time scrubber** under it that
   replays the flight (Dedrone/AeroScope "playback"). Scrubbing moves a marker
   on the map and a cursor on the profiles.
4. **Profiles on a shared time axis** — height AGL, speed, and RSSI per
   receiver. The existing `RssiChart` becomes one lane of this.
5. **Two columns below** — Identity (broadcast fields, MACs, operator ID) and
   Evidence, collapsed to one line ("Class A Remote ID via wifi · 2302 frames
   · confidence 60 %") with the noisy-OR arithmetic behind a disclosure.
   Receivers renders here once `receivers` is added to the GraphQL query.
6. **This aircraft** — "26 flights, Sep 4 – Sep 15", prev / next flight
   buttons, and a row of path thumbnails linking to the other flights. This is
   the Flightradar24 aircraft → flights structure, inverted from the detail
   page.

Position history (the 500-row `<details>` table) stays available under the
profiles as an export-oriented disclosure.

## Data the UI needs and where it comes from

| Value | Today | Proposed |
|---|---|---|
| Start, duration | `first_seen`, `last_seen` in list payload; not rendered | Compute client-side. No backend change. |
| Path thumbnail | `history[]` (≤ 4096 points) in list payload | Simplify client-side (Douglas-Peucker to ~64 points) for the thumbnail. Later: fusion stores `summary.path_simplified` at close so the list payload stops shipping thousands of points per row. |
| Max range, operator distance | Receiver position in settings; `geo.ts` has the math | Client-side from `history[]` now; `summary.max_range_m` from fusion later. |
| Max AGL, max speed | Per-point in `history[]` | Same pattern. |
| Time window | `since` exists; no `until` | Add `until` to `/tracks` and `TracksQuery`. |
| Vendor / serial facet | Not filterable server-side | Add `serial`, `vendor` params to `/tracks`, or filter client-side while the closed set is < 1000. |
| Labels | Nothing | New `aircraft_labels` table keyed by serial; `GET/PUT /aircraft/{serial}/label`. |
| Receivers on detail | Server exposes; GraphQL query omits | Add `receivers` to `graphql.ts` and `mapTrack`. Bug, fix regardless. |

Adding a `summary` object to `schemas/track.schema.json` is optional and
additive, but it still touches Go (fusion writes it, API stores it) and
TypeScript together per the schema rule. Everything in "Phase 1" below works
without it.

## Phasing

**Phase 1 — UI only.** Start/Duration/thumbnail/max-range columns computed
from the existing list payload; hide State and Confidence on the closed table;
group-by-aircraft; URL search params; expandable row quick view; render the
unidentified partition; add `receivers` to the GraphQL query.

**Phase 2 — API.** `until`, `serial`, `vendor` params; per-aircraft labels;
optional `summary` on the track document so list rows are cheap.

**Phase 3 — Detail page.** Fixed hierarchy, summary strip, full-width map with
scrubber, shared-axis profiles, "This aircraft" navigation. Remove the sortable
card grid and its settings entry.

## Sources

- Dedrone DroneTracker 3.1 user manual (alert list columns and filters, alert details layout): https://www.unibelus.by/upload/files/5ea0b514-84ca-11e8-8107-00155d045202.pdf
- DedroneTracker.AI 6.0 release (alert groups/events, replay): https://www.dedrone.com/blog/the-release-of-dedronetracker-ai-6-0
- Dedrone, turning detection data into action (hour/day charts, heatmap, by-sensor): https://www.dedrone.com/blog/turning-drone-detection-data-into-action-with-dedronetracker
- DJI AeroScope Management System user guide (Flight History, Track Playback, Statistical Report): https://dl.djicdn.com/downloads/AEROSCOPE/20190925/Aeroscope_Management_System_User_Guide_EN.pdf
- Flightradar24 flight information panel: https://www.flightradar24.com/blog/an-overview-of-the-updated-flight-information-panel-on-flightradar24-com/
- Strava, activity stats in the feed: https://support.strava.com/hc/en-us/articles/15422373796493-Activity-Stats-in-the-Feed
- Kibana Discover histogram + filter pills: https://www.elastic.co/kibana/features
- Linear issue grouping: https://linear.app/changelog/2021-02-12-issue-grouping
- Pencil & Paper, enterprise data tables: https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables
- Eleken, table design UX: https://www.eleken.co/blog-posts/table-design-ux
- saasui.design, data table patterns: https://www.saasui.design/blog/saas-data-table-ux-patterns
- NN/g, applying filters: https://www.nngroup.com/articles/applying-filters/
- NN/g, filters vs facets: https://www.nngroup.com/articles/filters-vs-facets/
- Drone Scanner (Dronetag): https://help.dronetag.com/drone-scanner/ ; DroneScout: https://play.google.com/store/apps/details?id=io.bluemark.dronescout

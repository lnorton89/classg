# UI upgrade plan

Status: proposal, September 15 2026. Written after walking every route of the
deployed unit (`pisdr`) as an operator, on desktop and at phone width, plus the
findings from [research/08-tracks-ux.md](../research/08-tracks-ux.md). Nothing
here is implemented except where marked.

## The verdict in one paragraph

The console is unusually honest and unusually well-explained, and that is also
why it feels half-baked: every screen carries its reasoning as prose, every
card weighs the same, and the same three or four patterns (key-value dump,
explanatory paragraph, drag-to-reorder grid, banner-that-teaches) are applied
whether or not the screen needs them. The information is right; the hierarchy
is missing. The upgrade is not a restyle. It is a decision, per screen, about
what the operator looks at first, what they act on, and what they can be told
once and never again.

## What was found, screen by screen

**Live.** The map takes several seconds to appear behind a "Loading map…" line
while the stat tiles and legend are already up, so the first frame is a grid
of zeros and a placeholder. The sky-state banner said "470 detections in the
last 5 minutes did not correlate into a track" on a quiet day; those are ADS-B
position reports from manned aircraft, which by design never become tracks, so
the sentence reads as a fusion fault. The Closed tracks list in the contacts
panel repeats one serial 29 times, and shows MAC-only fingerprint tracks with
one or two detections alongside real flights. The legend is permanently open.
The mobile layout (map, Map/Contacts toggle, bottom tabs) is the strongest
screen in the app.

**Tracks / track detail.** Covered by the research doc; Phases 1 to 3 are in
progress. The "Track state key" teaching band renders on every visit.

**Timeline.** Sound idea, thin execution: four bars on a 24 h band, a table
underneath that duplicates the Tracks table with the old columns. It should
become a view of the Flights page, not a second page.

**Sensors.** The richest data in the app presented as a 40-row key-value dump
with no grouping by importance. Two permanent error-styled boxes ("Restart
unavailable — systemctl is not available in the API runtime", "Capture is not
implemented for SDR sensors yet") describe the build, not a fault. The survey
note is printed twice. Per-channel counts that want to be bars are comma
lists. The band-sweep tool lives inside the sdr-0 card; `/spectrum` just
redirects there. The wifi-0 page shows a real problem clearly though: 8.1
million beacons heard, 13,708 drone detections, 50 minutes lost to hopping.
That is a story the page could tell in one strip.

**Event log.** Good. Sessions from the Claude desktop's embedded browser start
with an ERROR: "Service worker registration failed … An unknown error occurred
when fetching the script". From the page, `/sw.js` fetches with 200 and the
right type, the context is secure, and only the registration fetch fails, so
this is most likely that browser refusing service workers rather than the
unit. Confirm in ordinary Chrome before spending time on it.

**Settings (12 sub-pages).** Every field has a paragraph. The intent is right
(this system explains itself) but the effect is that nothing is scannable and
Save buttons are far from what they save. The Calibration page carries a
channel plan editor that, by its own description, changes nothing on the
running receiver ("Recorded here, applied by file"). The receiver position on
this unit was 46.0084, −122.8446 while every flight's operator stands near
46.0388, −122.7678, seven kilometres away, which the Wi-Fi sensor could not
hear; it was corrected to the surveyed position on Sep 15 (see the table
below). About showed "Revision: Not stamped" because container builds exclude
`.git`; the deploy agent knows the SHA and now passes it as a build arg.

**Administration.** Access and Outbound are clean. "This unit" had a red
"needs attention" alert that was a false alarm: the watchdog rendered the
TP-Link unit template with the wrong interface and reported drift on every
pass since September 10 (fixed in `scripts/classg-watchdog.sh`, this
session). The alert copy also asserted a restart ladder had been exhausted
when no restart was ever attempted (fixed in `watchdog-panel.tsx`). The deploy
history shows two "failed" runs from September 7 without their reason on the
row; the reason in the agent's log is "git fetch failed", a transient network
error. The drag-to-reorder card grid appears here too.

**Header and navigation.** Primary nav is Live, Tracks, Timeline, Sensors.
Logs, Docs, Settings, Administration and Captures are reachable only through
icons and the gear menu. The bell showed 10 unread on a fresh session.

## The upgrade, as workstreams

### A. One visual system, applied with hierarchy

- A single page-header component: title, one line of description, actions on
  the right. Rationale moves behind a "Why?" disclosure or into the in-app docs.
- Three card weights instead of one: primary (the thing the page is for),
  secondary, and plain sections with no border. Retire the drag-to-reorder grid
  everywhere (tracks, admin) in favour of fixed hierarchies.
- A status vocabulary: one pill component with fixed tones for ok / warn / down
  / info, used identically in the header, sensors, admin, and tables.
- Key-value lists get grouping headers, a primary-metrics strip above them, and
  inline bars for any per-channel or per-receiver breakdown.
- Empty, loading and error states from one set of components; skeletons rather
  than "Loading…" text; the map area holds its size while tiles load.
- Density and text-size settings already exist; make the compact density real
  on tables and key-value lists.
- Contrast pass on muted text over the night ground, and a light-theme pass on
  every page.

### B. Navigation and app shell

- Desktop: a left rail with Live, Flights, Timeline, Sensors, Spectrum,
  Captures, Log, Settings, Administration. Mobile keeps the bottom tabs and
  gains a "More" sheet for the rest.
- Global search in the header that actually resolves serial, MAC, track ULID
  and label to the flight or aircraft.
- Detail pages get a back link and a breadcrumb; the "teaching" banners
  (track state key, sky state explanation) become one-time dismissible.
- URL state on every list and filter (the Tracks route convention from Phase 1).

### C. Tell the operator what they need, not everything

- Live banner: separate manned traffic from drone activity in the sentence.
- Contacts panel: group closed tracks by aircraft with labels, shelve
  unidentified fingerprint tracks.
- Sensors: a per-sensor summary strip (heard / detected / listening share /
  lost to hopping / last drone), then grouped detail; build-limitation notes
  become one muted line or vanish on builds where they always apply.
- Timeline becomes a lanes view on the Flights page.
- Settings: group fields under a heading with one shared explanation; put Save
  next to the group; show dirty and saved state; remove or wire the channel
  plan editor.

### D. Correctness debt found on the way

| Item | Severity | Notes |
|---|---|---|
| Receiver position 7 km from where flights happen | fixed | Was 46.0084, −122.8446; set to 46.040333, −122.766389 from the operator's surveyed position on Sep 15. |
| Service worker fails to register | unconfirmed | Seen only from the Claude desktop's embedded browser, where `/sw.js` fetches fine from the page but the registration fetch fails; likely that browser, not the unit. Check the Event log in ordinary Chrome. |
| Watchdog false drift report | fixed | `check_unit_drift` read `--iface` for a template whose placeholder is `--companion-iface`. |
| Self-repair alert claims a restart ladder was exhausted | fixed | Copy now quotes the watchdog's own sentence. |
| Live banner counts ADS-B as failed correlations | fixed | Quiet-sky sentence now separates manned traffic from drone-band detections. |
| Deploy history rows hide the failure reason | fixed | Reason shown on the row for any non-success result. |
| "Revision: Not stamped" | fixed | `CLASSG_BUILD_REVISION` / `CLASSG_BUILD_TIME` build args, stamped by `pi-autodeploy.sh` and `make compose-up`. |
| Fusion resume after out-of-range gap | fixed | See `ResumeWithin` in `services/fusion/track.go`. |

## Sequencing

1. Land Phases 1 to 3 of the Tracks work (in progress), the fusion resume fix,
   and the two watchdog fixes. Confirm the receiver position with the operator
   before trusting any range figure.
2. Workstream A: the shared components (page header, card weights, pill,
   metrics strip, key-value groups, states). Two to three days; no behaviour
   change, every page moves onto them.
3. Workstream B: app shell and search. One to two days.
4. Workstream C: page by page, Live and Sensors first because they are what an
   operator looks at every day; Settings last because it is visited least.
5. Workstream D items not already fixed, interleaved: service worker first.

Each step is verifiable on the deployed unit through the Browser pane with the
`claude` account, and each should ship with before/after screenshots at desktop
and phone width.

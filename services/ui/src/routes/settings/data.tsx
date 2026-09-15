import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/misc'
import { Why } from '@/components/ui/why'
import { SettingsGroup } from '@/features/settings/setting-fields'
import { settingsQuery } from '@/lib/api/queries'
import { asReceiverPosition } from '@/lib/api/types'

export const Route = createFileRoute('/settings/data')({
  component: ExternalDataSettings,
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery()),
})

/**
 * The optional third-party data sources — docs/ops/07-external-data.md.
 *
 * Its own category rather than more cards on Calibration, because calibration
 * is about tuning what this receiver already does and these change what it
 * *reaches for*. One of them is the only thing in the system that makes an
 * outbound request, which is a decision worth surfacing on a page of its own
 * rather than four scrolls down someone else's.
 */
function ExternalDataSettings() {
  return (
    <>
      {/* One banner, not two. Both said something true about every card below,
          and stacked they pushed the first actual control off a phone screen.
          The half that changes what an operator does with the page — a save
          here is intent, not proof — leads; the reassurance folds away. */}
      <Alert tone="warn" title="Saving here records intent; fusion reads the environment">
        A value stored on this page reaches fusion once the matching{' '}
        <code className="font-mono text-xs">CLASSG_*</code> variable is set and fusion restarts,
        because fusion assembles its configuration from the environment rather than the
        database. The Sensors page is where you confirm what is actually running.
        <Why label="What happens if one of these is wrong or missing?" className="mt-2">
          Each source enriches detections that already work without it, so each degrades rather
          than fails: a missing file or a dropped uplink costs the enrichment and nothing else.
          All of them are inbound only — no detection, and no operator position, ever leaves
          this unit.
        </Why>
      </Alert>

      <NetworkADSBCard />
      <TerrainCard />
      <RegistriesCard />
      <BasemapNote />
    </>
  )
}

/**
 * Class D never raises a track's confidence — it exists to explain detections
 * away. Saying so here matters: "turn on aircraft tracking" reads like a
 * detection upgrade, and it is the opposite, a false-positive suppressor.
 */
function NetworkADSBCard() {
  const { data } = useQuery(settingsQuery())
  const position = asReceiverPosition(data?.settings['map.receiver_position']?.value)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Network ADS-B</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Shown whenever the position is unset, not only once the feed has
            been switched on. Gating it on the *saved* toggle meant the
            prerequisite appeared one step too late: you turned the feed on,
            saved, and only then learned it could not start. */}
        {!position ? (
          <Alert tone="warn" title="Needs a receiver position before it can start">
            The query is a radius around this unit, so fusion refuses to start the feed without
            one — 0,0 is treated as unset rather than as the Gulf of Guinea. Set it on{' '}
            <Link to="/settings/calibration" className="underline">
              Calibration
            </Link>
            .
          </Alert>
        ) : null}

        <SettingsGroup
          description="Manned traffic from community receivers, for units with no SDR fitted. The only setting on this page that makes an outbound request."
          why={
            <>
              It suppresses false positives — an airliner explained is a drone not reported —
              and never adds to a track&rsquo;s confidence. The request is a radius around this
              unit, so it also reveals roughly where the unit is; that is the trade, and it is
              the reason this one is off by default on a deployment that would rather not say.
            </>
          }
          fields={[
            { key: 'fusion.net_adsb', label: 'Poll a network aggregator', kind: 'switch' },
            { key: 'fusion.net_adsb_url', label: 'Aggregator', kind: 'text' },
            { key: 'fusion.net_adsb_radius_nm', label: 'Radius (nm)', kind: 'number' },
            { key: 'fusion.net_adsb_interval', label: 'Poll interval', kind: 'text' },
            { key: 'fusion.net_adsb_sensor_id', label: 'Sensor id', kind: 'text' },
          ]}
        />
      </CardContent>
    </Card>
  )
}

function TerrainCard() {
  const { data } = useQuery(settingsQuery())
  const enabled = data?.settings['fusion.terrain']?.value === true
  const offset = Number(data?.settings['fusion.terrain_geoid_offset_m']?.value ?? 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Terrain elevation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {enabled && offset === 0 ? (
          <Alert tone="warn" title="Heights will be wrong by the local geoid undulation">
            Elevation datasets report height above the geoid; Remote ID reports height above the
            WGS-84 ellipsoid. Leaving the offset at zero does not skip a correction — it applies
            a wrong one, in the direction that makes flights look <em>lower</em> than they are.
            Roughly &minus;22&nbsp;m around Seattle, up to 100&nbsp;m elsewhere.
          </Alert>
        ) : null}

        <SettingsGroup
          description="Fills height above ground by subtracting terrain from reported altitude. A height the aircraft reported itself is never overwritten."
          why={
            <>
              400 m over the river and 400 m over the ridge behind it are the same altitude and
              very different situations, which is the whole reason to derive the difference.
            </>
          }
          fields={[
            { key: 'fusion.terrain', label: 'Derive height above ground', kind: 'switch' },
            { key: 'fusion.terrain_url', label: 'Elevation service', kind: 'text' },
            { key: 'fusion.terrain_dataset', label: 'Dataset', kind: 'text' },
            {
              key: 'fusion.terrain_min_interval',
              label: 'Minimum interval between lookups',
              kind: 'text',
              hint: 'Rate limit on the public service. Set 0 when you self-host — terrain does not change, so a local instance answers forever with nothing leaving the unit.',
            },
            {
              key: 'fusion.terrain_geoid_offset_m',
              label: 'Geoid offset (m)',
              kind: 'number',
              hint: 'Local geoid undulation. Look it up once for where this unit is — it is a property of the place, not of the flight.',
            },
          ]}
        />
      </CardContent>
    </Card>
  )
}

function RegistriesCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Offline registries</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SettingsGroup
          description={
            <>
              Two downloaded files, read from disk and never over the network. Fetch both with{' '}
              <code className="font-mono text-xs">make data</code>.
            </>
          }
          why={
            <>
              An absent file costs the enrichment and nothing else — contacts keep their hex
              address, and Class C keeps the hand-listed OUIs.
            </>
          }
          fields={[
            { key: 'fusion.aircraft_db', label: 'Aircraft database (CSV)', kind: 'text' },
            { key: 'sensors.oui_registry', label: 'IEEE OUI registry (CSV)', kind: 'text' },
          ]}
        />
      </CardContent>
    </Card>
  )
}

/**
 * Deliberately not editable. Vite substitutes it at build time, so there is no
 * value here to store — and a control that looked like the others but silently
 * did nothing would be worse than a paragraph saying where it actually lives.
 */
function BasemapNote() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vector basemap</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          Set at build time with{' '}
          <code className="font-mono text-xs">VITE_BASEMAP_VECTOR_URL</code>, so it has no
          control here: the value is baked into the app you are currently running.
        </p>
        <Why label="What is it, and how do I change it?">
          A Protomaps <code className="font-mono text-xs">.pmtiles</code> archive is the only
          basemap that works with the uplink unplugged, and unlike the satellite imagery it can
          be shipped inside an image. Cut one with{' '}
          <code className="font-mono text-xs">scripts/fetch-basemap.sh</code> and rebuild. The
          map probes for it, then the satellite proxy, then falls back to range rings; the
          attribution in the corner tells you which one you got.
        </Why>
      </CardContent>
    </Card>
  )
}

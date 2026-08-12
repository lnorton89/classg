import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/misc'
import { SettingsGroup } from '@/features/settings/setting-fields'
import { settingsQuery } from '@/lib/api/queries'
import type { ReceiverPosition } from '@/lib/api/types'

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
export function ExternalDataSettings() {
  return (
    <>
      <Alert tone="info" title="Everything here is optional, and off until you turn it on">
        Each source enriches detections that already work without it, so each degrades rather
        than fails: a missing file or a dropped uplink costs the enrichment and nothing else.
        All of them are inbound only — no detection, and no operator position, ever leaves this
        unit.
      </Alert>

      <Alert tone="warn" title="Fusion reads these at startup, from the environment">
        Saving here changes what the receiver is <em>configured</em> to do. Fusion reads the
        environment rather than the database, so a change reaches it once the matching{' '}
        <code className="font-mono text-xs">CLASSG_*</code> variable is set and fusion restarts.
        This page is the record of intent, not proof of what is running — the Sensors page is
        where you confirm the latter.
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
  const position = data?.settings['map.receiver_position']?.value as ReceiverPosition | null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Network ADS-B</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          Manned traffic from community receivers, for units with no SDR fitted. It suppresses
          false positives — an airliner explained is a drone not reported — and never adds to a
          track&rsquo;s confidence. This is the only setting on this page that makes an outbound
          request, and the only one that reveals roughly where this unit is.
        </p>

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
        <p className="text-muted-foreground text-sm">
          Fills height above ground by subtracting terrain from reported altitude. 400 m over
          the river and 400 m over the ridge behind it are the same altitude and very different
          situations. A height the aircraft reported itself is never overwritten.
        </p>

        {enabled && offset === 0 ? (
          <Alert tone="warn" title="Heights will be wrong by the local geoid undulation">
            Elevation datasets report height above the geoid; Remote ID reports height above the
            WGS-84 ellipsoid. Leaving the offset at zero does not skip a correction — it applies
            a wrong one, in the direction that makes flights look <em>lower</em> than they are.
            Roughly &minus;22&nbsp;m around Seattle, up to 100&nbsp;m elsewhere.
          </Alert>
        ) : null}

        <SettingsGroup
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
        <p className="text-muted-foreground text-sm">
          Two downloaded files, read from disk and never over the network. Fetch both with{' '}
          <code className="font-mono text-xs">make data</code>. An absent file costs the
          enrichment and nothing else — contacts keep their hex address, and Class C keeps the
          hand-listed OUIs.
        </p>
        <SettingsGroup
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
          A Protomaps <code className="font-mono text-xs">.pmtiles</code> archive is the only
          basemap that works with the uplink unplugged, and unlike the satellite imagery it can
          be shipped inside an image. Cut one with{' '}
          <code className="font-mono text-xs">scripts/fetch-basemap.sh</code>.
        </p>
        <p className="text-muted-foreground text-sm">
          It is set at build time, with{' '}
          <code className="font-mono text-xs">VITE_BASEMAP_VECTOR_URL</code>, so it cannot be
          changed from here — the value is baked into the app you are currently running. The map
          probes for it, then the satellite proxy, then falls back to range rings; the
          attribution in the corner tells you which one you got.
        </p>
      </CardContent>
    </Card>
  )
}

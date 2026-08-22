import { useQuery } from '@tanstack/react-query'
import {
  addProtocol,
  AttributionControl,
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Link } from '@tanstack/react-router'
import { LocateFixedIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { useTheme } from '@/app/theme-context'
import { useFormat } from '@/app/use-format'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { useHasRole } from '@/features/auth/use-auth'
import { settingsQuery } from '@/lib/api/queries'
import { asReceiverPosition } from '@/lib/api/types'
import type { Detection, ReceiverPosition, Track } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { boundsOf, operatorLinksGeoJson, plottablePoints, trailsGeoJson } from './geo'
import {
  createDroneMarker,
  createMannedMarker,
  createOperatorMarker,
  updateDroneMarker,
  updateMannedMarker,
} from './markers'
import {
  BASEMAP_VECTOR_URL,
  isPMTilesArchive,
  noTilesStyle,
  rangeRings,
  ringRadiiFor,
  tiledStyle,
  tilesReachable,
  vectorReachable,
  vectorStyle,
  WORLD_MAX_ZOOM,
  worldArchiveUrlFor,
  type BasemapMode,
} from './style'

// `?worker&url` (not plain `?url`) — the dist worker imports a sibling shared
// module, and a bare URL emit drops it, so tiles silently never load in prod.
setWorkerUrl(workerUrl)

const BASE_URL = import.meta.env.BASE_URL

/**
 * Resolve a design token to a color literal MapLibre can parse.
 *
 * The paint below used to hardcode what `--operator` and `--track` already
 * define, so retuning a token recolored the markers and legend but not the
 * canvas. MapLibre needs literals, and its color parser knows only
 * hex/rgb/hsl/named — the tokens are authored in oklch — so the browser does
 * the conversion: paint the color into a 1x1 canvas and read the bytes back.
 * Called at style creation, which already re-runs per theme.
 *
 * The fallback keeps a test DOM (no 2d context) and a blank token from
 * silently painting black.
 */
function resolveTokenColor(token: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  if (raw === '') return fallback
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return fallback
  ctx.fillStyle = raw
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r},${g},${b})`
}

/**
 * Basemap layers that stand in for "there is map here".
 *
 * `earth` alone would be enough on land and wrong at sea, so water counts too.
 * Roads and landuse are included because a coastal extract can put a viewport
 * over water that the archive genuinely covers.
 */
const BASEMAP_COVERAGE_LAYERS = ['earth', 'water', 'landuse', 'roads-major', 'roads-minor']

/**
 * Centre of the contiguous US at a zoom that keeps it on screen on a normal
 * desktop window. The fallback when nothing — not a configured receiver
 * position, not the operator's own ODID position, not browser geolocation —
 * has told the map where "here" is. A flat [0, 0] world view reads as broken
 * rather than merely uninformative, and this deployment's operators are
 * overwhelmingly in the US.
 */
const FALLBACK_CENTER: [number, number] = [-98.5, 39.5]
const FALLBACK_ZOOM = 3.3

/**
 * The operator's last view of THIS map, remembered per browser.
 *
 * Without it every visit reopened on whatever the fallbacks produced and the
 * zoom-in to the site was repeated by hand each session. It ranks above the
 * receiver-position jump -- a view somebody chose beats a view we derived --
 * and below fit-to-contacts, same as every other claim on the camera.
 *
 * Validated on the way back in, not trusted: this goes straight into the map
 * constructor, which throws on a malformed centre, and localStorage survives
 * schema changes that this code does not.
 */
const VIEWPORT_KEY = 'classg.live-map.viewport'

interface SavedViewport {
  center: [number, number]
  zoom: number
}

function loadSavedViewport(): SavedViewport | null {
  try {
    const raw = localStorage.getItem(VIEWPORT_KEY)
    if (!raw) return null
    // Typed as unknowns, not as SavedViewport: the whole point of this parse
    // is that localStorage holds whatever an older build wrote.
    const parsed = JSON.parse(raw) as { center?: unknown; zoom?: unknown }
    if (!Array.isArray(parsed.center) || parsed.center.length !== 2) return null
    const [lon, lat] = parsed.center as [unknown, unknown]
    if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return null
    if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) return null
    if (typeof parsed.zoom !== 'number' || !Number.isFinite(parsed.zoom)) return null
    return { center: [lon, lat], zoom: parsed.zoom }
  } catch {
    return null
  }
}

/**
 * Whether the "this map doesn't know where it is" prompt was dismissed.
 *
 * Per browser and permanent once dismissed: the prompt exists to teach that the
 * setting exists, and a lesson that reappears on every visit stops being a
 * lesson. Setting the position clears the condition it renders under anyway.
 */
const POSITION_PROMPT_DISMISSED_KEY = 'classg.live-map.position-prompt-dismissed'

/**
 * Register the `pmtiles://` protocol, once, and only if an archive is actually
 * configured.
 *
 * Dynamically imported so the decoder stays out of the main chunk on the many
 * deployments that use raster tiles or none at all — the same reason
 * maplibre-gl itself is split out in vite.config.ts. The shell has to stay
 * interactive on a phone over the Pi's own access point.
 */
let pmtilesProtocol: Promise<void> | null = null
function ensurePMTilesProtocol(): Promise<void> {
  pmtilesProtocol ??= import('pmtiles').then(({ Protocol }) => {
    addProtocol('pmtiles', new Protocol().tile)
  })
  return pmtilesProtocol
}

export interface LiveMapProps {
  tracks: Track[]
  adsb: Detection[]
  selectedTrackId: string | null
  onSelectTrack?: (trackId: string | null) => void
  /** ICAO address of the selected manned contact. Keyed as the manned markers are. */
  selectedMannedIcao?: string | null
  onSelectManned?: (icao: string | null) => void
  /** Dim + hatch the map when what it shows cannot be trusted. */
  coverageBroken: boolean
  className: string
  ariaLabel?: string
  fitOnTrackChanges?: boolean
  fitMaxZoom?: number
  /**
   * This map is the site overview, as opposed to a one-track detail view:
   * remember the operator's viewport between visits, offer a
   * centre-on-receiver control, and prompt an admin when the receiver's
   * position was never configured. TrackMap reuses this component and must
   * not inherit any of that -- a flight's close-up is not "where was I", and
   * the prompt on a detail page would be noise.
   */
  siteAnchored?: boolean
}

export function LiveMap({
  tracks,
  adsb,
  selectedTrackId,
  onSelectTrack,
  selectedMannedIcao = null,
  onSelectManned,
  coverageBroken,
  className,
  ariaLabel = 'Live airspace map',
  fitOnTrackChanges = false,
  fitMaxZoom = 16,
  siteAnchored = false,
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const droneMarkers = useRef(new Map<string, { marker: Marker; node: HTMLElement }>())
  const operatorMarkers = useRef(new Map<string, Marker>())
  const mannedMarkers = useRef(new Map<string, { marker: Marker; node: HTMLElement }>())
  const onSelectRef = useRef(onSelectTrack)
  const onSelectMannedRef = useRef(onSelectManned)
  const fittedBoundsRef = useRef<string | null>(null)
  const initialCenterAppliedRef = useRef(false)
  // Marker accessible names are the text equivalent of the canvas, so they
  // follow the operator's unit preference like every other reading.
  const format = useFormat()

  // The scale bar follows the unit preference too — a console reading knots
  // and nautical miles everywhere else must not measure the map in km.
  // MapLibre's ScaleControl has no "aviation", so that maps to nautical.
  const { preferences } = usePreferences()
  const scaleUnit: 'metric' | 'imperial' | 'nautical' =
    preferences.units === 'metric'
      ? 'metric'
      : preferences.units === 'aviation'
        ? 'nautical'
        : 'imperial'
  const scaleControlRef = useRef<ScaleControl | null>(null)
  // A ref so the map-creation effect can read the current unit without
  // listing it as a dependency — a unit change must retune the control, not
  // rebuild the whole map.
  const scaleUnitRef = useRef(scaleUnit)

  useEffect(() => {
    scaleUnitRef.current = scaleUnit
    scaleControlRef.current?.setUnit(scaleUnit)
  }, [scaleUnit])

  useEffect(() => {
    onSelectRef.current = onSelectTrack
  }, [onSelectTrack])

  useEffect(() => {
    onSelectMannedRef.current = onSelectManned
  }, [onSelectManned])

  const { theme } = useTheme()
  const [basemap, setBasemap] = useState<BasemapMode | null>(null)
  // Vector archives cover one cut-out of the world; this tracks whether the
  // current view is inside it. See checkCoverage below.
  const [outsideCoverage, setOutsideCoverage] = useState(false)
  // The whole-world companion archive, when one sits next to the local
  // extract. It fills the void around the extract when zooming out — see
  // WORLD_MAX_ZOOM in style.ts for why the extract alone cannot.
  const [worldArchive, setWorldArchive] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  // False until the first `idle` -- the point at which every tile in view has
  // actually arrived. Over a Tailscale link to a Pi that is seconds, and the
  // map spends them as a featureless void that is pixel-identical to a broken
  // one; the chip below names the difference.
  const [tilesSettled, setTilesSettled] = useState(false)
  const [positionPromptDismissed, setPositionPromptDismissed] = useState(
    () => localStorage.getItem(POSITION_PROMPT_DISMISSED_KEY) === 'true',
  )
  const isAdmin = useHasRole('admin')

  // --- where to centre before any track exists to derive a position from --
  // Configured receiver position beats browser geolocation: a fixed
  // installation should never see a permission prompt for a position it
  // already knows, and the receiver position is shared by every client while
  // geolocation is per-device.
  const { data: settingsData } = useQuery(settingsQuery())
  const receiverPositionSetting = settingsData?.settings['map.receiver_position']
  // Guarded, not cast: the settings store is stringly typed and this value
  // goes straight into map.jumpTo, which throws on a malformed centre.
  const receiverPosition = asReceiverPosition(receiverPositionSetting?.value)
  const settingsResolved = settingsData !== undefined

  const [browserLocation, setBrowserLocation] = useState<ReceiverPosition | null>(null)

  useEffect(() => {
    if (!settingsResolved || receiverPosition) return
    // navigator.geolocation is undefined on insecure origins — the same trap
    // as navigator.clipboard in copy-button.tsx: a Pi reached over plain http
    // on a LAN address won't have it, so this degrades to the world view
    // rather than throwing.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!window.isSecureContext || !navigator.geolocation) return
    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (cancelled) return
        setBrowserLocation({ lat: position.coords.latitude, lon: position.coords.longitude })
      },
      () => {
        // Denied, unavailable, or timed out — the world view is the fallback
        // for exactly this case, not an error to surface.
      },
      { maximumAge: 300_000, timeout: 10_000 },
    )
    return () => {
      cancelled = true
    }
  }, [settingsResolved, receiverPosition])

  // --- probe for a basemap once --------------------------------------------
  // Vector first when configured: it is the only source that works with the
  // uplink down. Raster is the fallback, and rings are the fallback to that —
  // never an error, because a detector with no map still detects.
  useEffect(() => {
    const controller = new AbortController()
    const choose = async () => {
      if (
        BASEMAP_VECTOR_URL &&
        (await vectorReachable(BASEMAP_VECTOR_URL, controller.signal))
      ) {
        if (isPMTilesArchive(BASEMAP_VECTOR_URL)) {
          await ensurePMTilesProtocol()
          // Probed rather than assumed: the world companion is optional, and
          // vectorReachable checks the PMTiles magic, so an SPA index.html
          // fallback at HTTP 200 cannot impersonate it.
          const world = worldArchiveUrlFor(BASEMAP_VECTOR_URL)
          if (await vectorReachable(world, controller.signal)) {
            if (!controller.signal.aborted) setWorldArchive(world)
          }
        }
        if (!controller.signal.aborted) setBasemap('vector')
        return
      }
      const raster = await tilesReachable(BASE_URL, controller.signal)
      if (!controller.signal.aborted) setBasemap(raster ? 'tiles' : 'no-tiles')
    }
    void choose().catch(() => {
      if (!controller.signal.aborted) setBasemap('no-tiles')
    })
    return () => controller.abort()
  }, [])

  // --- create the map ------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || basemap === null) return

    // A vector URL that is not an archive is somebody else's style document —
    // OpenFreeMap and friends — so it is handed to MapLibre as a URL rather
    // than rebuilt here.
    const style =
      basemap === 'vector'
        ? isPMTilesArchive(BASEMAP_VECTOR_URL)
          ? vectorStyle(theme, BASEMAP_VECTOR_URL, worldArchive)
          : BASEMAP_VECTOR_URL
        : basemap === 'tiles'
          ? tiledStyle(theme, BASE_URL)
          : noTilesStyle(theme)
    const savedViewport = siteAnchored ? loadSavedViewport() : null
    const map = new MapLibreMap({
      container: containerRef.current,
      style,
      center: savedViewport?.center ?? FALLBACK_CENTER,
      zoom: savedViewport?.zoom ?? FALLBACK_ZOOM,
      attributionControl: basemap === 'no-tiles' ? false : undefined,
      // Two-finger pan on touch so the page can still be scrolled past the map
      // on a phone.
      cooperativeGestures: true,
    })
    mapRef.current = map
    fittedBoundsRef.current = null
    // A restored viewport counts as the initial centre having been chosen:
    // the receiver-position jump must not yank the camera away from a view
    // the operator set up on a previous visit.
    initialCenterAppliedRef.current = savedViewport !== null
    setTilesSettled(false)

    // MapLibre sizes its canvas from the container's dimensions at the moment
    // it is constructed. This container is flex-laid-out next to a sidebar
    // and switches panes on mobile, so that size is not always settled yet —
    // without either of the two lines below, the canvas can freeze at a stale
    // (often much narrower) size and render tiles into only part of its own
    // element, leaving the rest black. The previous code only called
    // resize() from the fit-to-contacts effect, which an empty sky never
    // runs, so this had no cure until the first track arrived.
    //
    // The observer catches every *later* size change (a sidebar toggling, the
    // mobile map/list pane switching, the window itself resizing). It does not
    // cover the construction race above, because nothing has changed size yet
    // for it to observe — a second layout pass (fonts, flex) can still commit
    // after `new MapLibreMap()` reads the container's current box. The rAF
    // catches exactly that one-shot case.
    const resizeObserver = new ResizeObserver(() => map.resize())
    resizeObserver.observe(containerRef.current)
    const initialResizeFrame = requestAnimationFrame(() => map.resize())

    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right')
    const scaleControl = new ScaleControl({ maxWidth: 90, unit: scaleUnitRef.current })
    map.addControl(scaleControl, 'bottom-left')
    scaleControlRef.current = scaleControl
    if (basemap !== 'no-tiles') {
      map.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    }

    // MapLibre gives the canvas no accessible name and does not mark the map as
    // a region. Upstream issues #362/#364; fixed here rather than waited on.
    const container = map.getContainer()
    container.setAttribute('role', 'region')
    container.setAttribute('aria-label', ariaLabel)
    map
      .getCanvas()
      .setAttribute('aria-label', `${ariaLabel}. Arrow keys pan; plus and minus zoom.`)
    // Controls set both `title` and `aria-label`, which NVDA announces twice.
    for (const button of container.querySelectorAll('.maplibregl-ctrl button')) {
      button.removeAttribute('title')
    }

    const drawRings = () => {
      const source = map.getSource('rings')
      if (!(source instanceof GeoJSONSource)) return
      const bounds = map.getBounds()
      const spanMetres =
        Math.abs(bounds.getEast() - bounds.getWest()) *
        111_320 *
        Math.cos((map.getCenter().lat * Math.PI) / 180)
      const centre = map.getCenter()
      void source.setData(rangeRings([centre.lng, centre.lat], ringRadiiFor(spanMetres)))
    }

    const addOverlays = () => {
      if (!map.getSource('trails')) {
        map.addSource('trails', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource('operator-links')) {
        map.addSource('operator-links', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getLayer('operator-links')) {
        map.addLayer({
          id: 'operator-links',
          type: 'line',
          source: 'operator-links',
          layout: { 'line-cap': 'round' },
          paint: {
            // The same --operator the markers and legend read, so all three
            // surfaces cannot drift apart. Fallbacks are the pre-token values.
            'line-color': resolveTokenColor(
              '--operator',
              theme === 'dark' ? '#e879c8' : '#a8368c',
            ),
            'line-width': 1.2,
            'line-opacity': 0.65,
            'line-dasharray': [1, 2],
          },
        })
      }
      if (!map.getLayer('trails')) {
        map.addLayer({
          id: 'trails',
          type: 'line',
          source: 'trails',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': resolveTokenColor(
              '--track',
              theme === 'dark' ? '#5fd3f0' : '#1e7fa8',
            ),
            // Trail width follows confidence — thicker means more corroborated,
            // within one hue. Never a hue ramp.
            'line-width': ['interpolate', ['linear'], ['get', 'confidence'], 0, 1, 1, 2.6],
            'line-opacity': ['case', ['get', 'stale'], 0.28, 0.7],
          },
        })
      }
      drawRings()
      setReady(true)
    }

    /**
     * Is any basemap actually drawn where we are looking?
     *
     * A `.pmtiles` archive holds one cut-out of the world, so panning or
     * zooming past its bounding box leaves a hard edge and then nothing —
     * pixel-identical to a basemap that failed to load, and on this display
     * uncomfortably close to what "no coverage" looks like. The probe that
     * chose this style only proved the archive exists, not that it covers
     * where the aircraft are.
     *
     * Asking what is rendered beats reading the source bounds: it stays true
     * for a hosted style, for a partial archive, and for the ocean.
     */
    const checkCoverage = () => {
      if (basemap !== 'vector') return
      // At or below the world companion's native zooms, every view is
      // genuinely covered — that is the whole point of the second archive.
      // Above them its earth/water are an overzoomed coarse wash, honest as
      // background but not as coverage, so the local layers still decide.
      if (worldArchive && map.getZoom() < WORLD_MAX_ZOOM + 1) {
        setOutsideCoverage(false)
        return
      }
      const drawn = map.queryRenderedFeatures({
        layers: BASEMAP_COVERAGE_LAYERS.filter((id) => map.getLayer(id)),
      }).length
      setOutsideCoverage(drawn === 0)
    }

    // Wherever the camera ends up is the view to reopen with next visit.
    // Deliberately including programmatic moves: the fit-to-contacts pass and
    // the receiver jump both end on "the current view", which is exactly what
    // "where was I" means.
    const persistViewport = () => {
      const centre = map.getCenter()
      try {
        localStorage.setItem(
          VIEWPORT_KEY,
          JSON.stringify({ center: [centre.lng, centre.lat], zoom: map.getZoom() }),
        )
      } catch {
        /* a full or unavailable localStorage costs only the memory feature */
      }
    }

    map.on('load', addOverlays)
    // setStyle() drops custom sources and layers; re-add them every time.
    map.on('styledata', addOverlays)
    map.on('moveend', drawRings)
    map.on('moveend', checkCoverage)
    if (siteAnchored) map.on('moveend', persistViewport)
    // `idle` is the one that fires after tiles finish arriving, so a pan into
    // covered ground clears the notice without waiting for the next gesture.
    map.on('idle', checkCoverage)
    map.once('idle', () => setTilesSettled(true))

    const drones = droneMarkers.current
    const operators = operatorMarkers.current
    const manned = mannedMarkers.current

    return () => {
      setReady(false)
      cancelAnimationFrame(initialResizeFrame)
      resizeObserver.disconnect()
      for (const { marker } of drones.values()) marker.remove()
      for (const marker of operators.values()) marker.remove()
      for (const { marker } of manned.values()) marker.remove()
      drones.clear()
      operators.clear()
      manned.clear()
      scaleControlRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [ariaLabel, basemap, siteAnchored, theme, worldArchive])

  // --- line sources --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const trails = map.getSource('trails')
    if (trails instanceof GeoJSONSource) void trails.setData(trailsGeoJson(tracks))
    const links = map.getSource('operator-links')
    if (links instanceof GeoJSONSource) void links.setData(operatorLinksGeoJson(tracks))
  }, [tracks, ready])

  // --- initial centre -------------------------------------------------------
  // The map is created at [0, 0] because neither source below is available
  // synchronously — the setting is a fetch and geolocation needs a permission
  // round trip. This applies once, and only before anything else has claimed
  // the view: a fit-to-contacts pass (below) or the operator panning it
  // themself. Once real tracks exist, where they are matters more than where
  // the receiver is.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || initialCenterAppliedRef.current) return
    if (fittedBoundsRef.current !== null) return
    const source = receiverPosition ?? browserLocation
    if (!source) return
    initialCenterAppliedRef.current = true
    map.jumpTo({ center: [source.lon, source.lat], zoom: 12 })
  }, [ready, receiverPosition, browserLocation])

  // --- drone + operator markers -------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const seen = new Set<string>()
    const seenOperators = new Set<string>()

    for (const track of tracks) {
      const current = track.current

      if (track.operator) {
        seenOperators.add(track.track_id)
        const label = track.identity?.serial ?? track.track_id.slice(-6)
        const existingOperator = operatorMarkers.current.get(track.track_id)
        if (existingOperator) {
          existingOperator.setLngLat([track.operator.lon, track.operator.lat])
        } else {
          const marker = new Marker({
            element: createOperatorMarker({ trackId: track.track_id, label }),
          })
            .setLngLat([track.operator.lon, track.operator.lat])
            .addTo(map)
          operatorMarkers.current.set(track.track_id, marker)
        }
      }

      if (!current) continue // history/operator can plot without a current aircraft fix
      seen.add(track.track_id)

      const options = {
        track,
        selected: track.track_id === selectedTrackId,
        onSelect: onSelectRef.current ? (id: string) => onSelectRef.current?.(id) : undefined,
        format,
      }
      const existing = droneMarkers.current.get(track.track_id)
      if (existing) {
        updateDroneMarker(existing.node, options)
        existing.marker.setLngLat([current.lon, current.lat])
      } else {
        const node = createDroneMarker(options)
        const marker = new Marker({ element: node })
          .setLngLat([current.lon, current.lat])
          .addTo(map)
        droneMarkers.current.set(track.track_id, { marker, node })
      }
    }

    for (const [id, entry] of droneMarkers.current) {
      if (!seen.has(id)) {
        entry.marker.remove()
        droneMarkers.current.delete(id)
      }
    }
    for (const [id, marker] of operatorMarkers.current) {
      if (!seenOperators.has(id)) {
        marker.remove()
        operatorMarkers.current.delete(id)
      }
    }
  }, [tracks, selectedTrackId, ready, format])

  // --- manned traffic ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const seen = new Set<string>()
    for (const detection of adsb) {
      const position = detection.position
      const icao = detection.adsb?.icao
      if (!position || !icao) continue
      seen.add(icao)

      const options = {
        icao,
        callsign: detection.adsb?.callsign ?? null,
        headingDeg: detection.kinematics?.track_deg ?? null,
        altFt: detection.adsb?.alt_ft ?? null,
        selected: icao === selectedMannedIcao,
        onSelect: onSelectMannedRef.current
          ? (id: string) => onSelectMannedRef.current?.(id)
          : undefined,
        format,
      }
      const existing = mannedMarkers.current.get(icao)
      if (existing) {
        updateMannedMarker(existing.node, options)
        existing.marker.setLngLat([position.lon, position.lat])
      } else {
        const node = createMannedMarker(options)
        const marker = new Marker({ element: node })
          .setLngLat([position.lon, position.lat])
          .addTo(map)
        mannedMarkers.current.set(icao, { marker, node })
      }
    }

    for (const [icao, entry] of mannedMarkers.current) {
      if (!seen.has(icao)) {
        entry.marker.remove()
        mannedMarkers.current.delete(icao)
      }
    }
  }, [adsb, ready, format, selectedMannedIcao])

  // --- route/contact fit ---------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const bounds = boundsOf(plottablePoints(tracks))
    if (!bounds) return
    const signature = [bounds.west, bounds.south, bounds.east, bounds.north]
      .map((value) => value.toFixed(7))
      .join(',')
    if (fittedBoundsRef.current === signature) return
    if (!fitOnTrackChanges && fittedBoundsRef.current !== null) return
    fittedBoundsRef.current = signature
    map.resize()
    map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 64, maxZoom: fitMaxZoom, duration: 0 },
    )
  }, [fitMaxZoom, fitOnTrackChanges, tracks, ready])

  return (
    <div className={cn('relative isolate', className)}>
      <div
        ref={containerRef}
        className="absolute inset-0"
        // MapLibre adds `.maplibregl-map { position: relative }` after mount.
        // Its stylesheet loads after Tailwind and otherwise wins the cascade,
        // collapsing this absolutely-positioned container to 0px tall.
        style={{ position: 'absolute' }}
        data-testid="map-canvas"
      />

      {/*
        When coverage is broken the map is not just annotated, it is visibly
        disabled: desaturated and hatched. An operator glancing at a phone in
        daylight must not be able to mistake it for a working display.

        Eased from 18% stripes over 60% grayscale, and the stripes widened from
        10px to 14px. At the old weight the hatch did not annotate the map so
        much as replace it -- the basemap underneath was unreadable, so a
        degraded system and a system with no tiles looked identical. The state
        still has to be unmissable, but it has to leave something to be
        degraded: hiding the map entirely removes the operator's ability to see
        where the last known contacts were, which is exactly what they reach for
        when coverage drops.
      */}
      {coverageBroken ? (
        <div
          aria-hidden
          data-testid="map-coverage-scrim"
          className="pointer-events-none absolute inset-0 z-10 bg-[repeating-linear-gradient(45deg,transparent_0_14px,color-mix(in_oklch,var(--down)_10%,transparent)_14px_28px)] backdrop-grayscale-[0.3]"
        />
      ) : null}

      {/*
        Until the first `idle`, what is on screen is a featureless ground with
        markers floating in it -- indistinguishable from a map that failed.
        Naming the wait is the whole fix: the void reads as loading instead of
        broken. Fades rather than popping out because tiles resolve outward
        from the centre and the exact end of "loading" is not a moment worth
        flashing about.
      */}
      {basemap !== 'no-tiles' && !tilesSettled ? (
        <p
          className="text-muted-foreground bg-background/80 ring-border pointer-events-none absolute top-1/2 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs ring-1"
          data-testid="map-loading"
        >
          <span
            aria-hidden
            className="border-muted-foreground/40 border-t-foreground size-3.5 animate-spin rounded-full border-2 motion-reduce:animate-none"
          />
          Loading map…
        </p>
      ) : null}

      {/* Same placement logic as MapLibre's own nav cluster: top-right, just
          below it. Only rendered once there is a "here" to centre on. */}
      {siteAnchored && (receiverPosition ?? browserLocation) ? (
        <Button
          variant="outline"
          size="icon"
          aria-label="Centre on the receiver"
          className="bg-background/90 absolute top-[110px] right-[10px] z-10 size-[29px] rounded-md"
          onClick={() => {
            const target = receiverPosition ?? browserLocation
            if (!target) return
            mapRef.current?.flyTo({ center: [target.lon, target.lat], zoom: 12, duration: 600 })
          }}
        >
          <LocateFixedIcon className="size-4" aria-hidden />
        </Button>
      ) : null}

      {/*
        The map has no idea where this receiver is, and the only cure is a
        setting four levels deep in Calibration. Without this prompt the
        console opens on a continent every single visit and nothing anywhere
        says why -- the single worst first-run impression this app can make.
        Admins only, because only they can act on it; dismissable exactly once
        per browser, because a lesson that nags stops being read.
      */}
      {siteAnchored &&
      isAdmin &&
      settingsResolved &&
      !receiverPosition &&
      !positionPromptDismissed ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
          <div className="bg-card/95 border-border text-card-foreground pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border p-3 text-sm shadow-lg backdrop-blur">
            <div className="min-w-0">
              <p className="font-medium">This map doesn’t know where the receiver is</p>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                Set the receiver’s position once and every visit opens here, centred on your
                site, instead of on a continent.
              </p>
              <Link
                to="/settings/calibration"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2')}
              >
                Set receiver position
              </Link>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss"
              className="-mt-1 -mr-1 shrink-0"
              onClick={() => {
                setPositionPromptDismissed(true)
                try {
                  localStorage.setItem(POSITION_PROMPT_DISMISSED_KEY, 'true')
                } catch {
                  /* dismissal just won't persist */
                }
              }}
            >
              <XIcon className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      {basemap === 'no-tiles' ? (
        <p className="text-muted-foreground bg-background/80 ring-border pointer-events-none absolute right-2 bottom-2 z-10 rounded px-2 py-1 text-2xs ring-1">
          No basemap tiles — range rings only
        </p>
      ) : null}

      {/* Named rather than left blank. An area extract simply stops at its
          bounding box, and a blank map on this console reads as "nothing
          detected" long before it reads as "you have panned off the edge of
          the tiles you cut". With the world companion underneath the view is
          never truly blank, but past its native zooms the wash it draws has no
          street detail, and that difference still deserves words. */}
      {basemap === 'vector' && outsideCoverage ? (
        <p className="text-muted-foreground bg-background/80 ring-border pointer-events-none absolute right-2 bottom-2 z-10 rounded px-2 py-1 text-2xs ring-1">
          {worldArchive
            ? 'Outside detailed basemap coverage — world overview only'
            : 'Outside basemap coverage — range rings only'}
        </p>
      ) : null}
    </div>
  )
}

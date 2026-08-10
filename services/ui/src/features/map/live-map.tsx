import {
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef, useState } from 'react'

import { useTheme } from '@/app/theme'
import type { Detection, Track } from '@/lib/api/types'
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
  noTilesStyle,
  rangeRings,
  ringRadiiFor,
  tiledStyle,
  tilesReachable,
  type BasemapMode,
} from './style'

// `?worker&url` (not plain `?url`) — the dist worker imports a sibling shared
// module, and a bare URL emit drops it, so tiles silently never load in prod.
setWorkerUrl(workerUrl)

const BASE_URL = import.meta.env.BASE_URL

export interface LiveMapProps {
  tracks: Track[]
  adsb: Detection[]
  selectedTrackId: string | null
  onSelectTrack: (trackId: string | null) => void
  /** Dim + hatch the map when what it shows cannot be trusted. */
  coverageBroken: boolean
  className: string
}

export function LiveMap({
  tracks,
  adsb,
  selectedTrackId,
  onSelectTrack,
  coverageBroken,
  className,
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const droneMarkers = useRef(new Map<string, { marker: Marker; node: HTMLElement }>())
  const operatorMarkers = useRef(new Map<string, Marker>())
  const mannedMarkers = useRef(new Map<string, { marker: Marker; node: HTMLElement }>())
  const onSelectRef = useRef(onSelectTrack)

  useEffect(() => {
    onSelectRef.current = onSelectTrack
  }, [onSelectTrack])

  const { theme } = useTheme()
  const [basemap, setBasemap] = useState<BasemapMode | null>(null)
  const [ready, setReady] = useState(false)

  // --- probe for tiles once ------------------------------------------------
  useEffect(() => {
    const controller = new AbortController()
    void tilesReachable(BASE_URL, controller.signal).then((ok) =>
      setBasemap(ok ? 'tiles' : 'no-tiles'),
    )
    return () => controller.abort()
  }, [])

  // --- create the map ------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || basemap === null) return

    const style = basemap === 'tiles' ? tiledStyle(theme, BASE_URL) : noTilesStyle(theme)
    const map = new MapLibreMap({
      container: containerRef.current,
      style,
      center: [0, 0],
      zoom: 1.5,
      attributionControl: basemap === 'tiles' ? undefined : false,
      // Two-finger pan on touch so the page can still be scrolled past the map
      // on a phone.
      cooperativeGestures: true,
    })
    mapRef.current = map

    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right')
    map.addControl(new ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left')

    // MapLibre gives the canvas no accessible name and does not mark the map as
    // a region. Upstream issues #362/#364; fixed here rather than waited on.
    const container = map.getContainer()
    container.setAttribute('role', 'region')
    container.setAttribute('aria-label', 'Live airspace map')
    map
      .getCanvas()
      .setAttribute(
        'aria-label',
        'Airspace map. Arrow keys pan, plus and minus zoom. A text list of all contacts is available beside the map.',
      )
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
            'line-color': theme === 'dark' ? '#e879c8' : '#a8368c',
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
            'line-color': theme === 'dark' ? '#5fd3f0' : '#1e7fa8',
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

    map.on('load', addOverlays)
    // setStyle() drops custom sources and layers; re-add them every time.
    map.on('styledata', addOverlays)
    map.on('moveend', drawRings)

    const drones = droneMarkers.current
    const operators = operatorMarkers.current
    const manned = mannedMarkers.current

    return () => {
      setReady(false)
      for (const { marker } of drones.values()) marker.remove()
      for (const marker of operators.values()) marker.remove()
      for (const { marker } of manned.values()) marker.remove()
      drones.clear()
      operators.clear()
      manned.clear()
      map.remove()
      mapRef.current = null
    }
  }, [basemap, theme])

  // --- line sources --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const trails = map.getSource('trails')
    if (trails instanceof GeoJSONSource) void trails.setData(trailsGeoJson(tracks))
    const links = map.getSource('operator-links')
    if (links instanceof GeoJSONSource) void links.setData(operatorLinksGeoJson(tracks))
  }, [tracks, ready])

  // --- drone + operator markers -------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const seen = new Set<string>()
    const seenOperators = new Set<string>()

    for (const track of tracks) {
      const current = track.current
      if (!current) continue // no GPS fix: listed in the contacts panel, not plotted
      seen.add(track.track_id)

      const options = {
        track,
        selected: track.track_id === selectedTrackId,
        onSelect: (id: string) => onSelectRef.current(id),
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
  }, [tracks, selectedTrackId, ready])

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
  }, [adsb, ready])

  // --- first fit -----------------------------------------------------------
  const fittedRef = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || fittedRef.current) return
    const bounds = boundsOf(plottablePoints(tracks))
    if (!bounds) return
    fittedRef.current = true
    map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 96, maxZoom: 16, duration: 0 },
    )
  }, [tracks, ready])

  return (
    <div className={cn('relative isolate', className)}>
      <div ref={containerRef} className="absolute inset-0" data-testid="map-canvas" />

      {/*
        When coverage is broken the map is not just annotated, it is visibly
        disabled: desaturated and hatched. An operator glancing at a phone in
        daylight must not be able to mistake it for a working display.
      */}
      {coverageBroken ? (
        <div
          aria-hidden
          data-testid="map-coverage-scrim"
          className="pointer-events-none absolute inset-0 z-10 bg-[repeating-linear-gradient(45deg,transparent_0_10px,color-mix(in_oklch,var(--down)_18%,transparent)_10px_20px)] backdrop-grayscale-[0.6]"
        />
      ) : null}

      {basemap === 'no-tiles' ? (
        <p className="text-muted-foreground bg-background/80 ring-border pointer-events-none absolute right-2 bottom-2 z-10 rounded px-2 py-1 text-[10px] ring-1">
          No basemap tiles — range rings only
        </p>
      ) : null}
    </div>
  )
}

/**
 * Geofence boundaries: named polygons a hook rule can require a drone's
 * position to fall inside.
 *
 * Drawing is click-to-place-vertex on a plain MapLibre map -- no drawing
 * library. The interaction this needs (place a point, see the ring grow,
 * undo the last one, save) is small enough that a dependency like
 * terra-draw would buy little beyond a bundle size line item; the map itself
 * is the same `maplibre-gl` every other page here already ships.
 *
 * A boundary an operator draws is very often their own property outline,
 * which is home address in every way that matters -- the API gates every
 * boundary endpoint as admin-only for exactly that reason, and this panel
 * lives next to Hooks rather than anywhere a viewer could land on it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GeoJSONSource, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { PlusIcon, Trash2Icon, Undo2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { useTheme } from '@/app/theme-context'
import { Alert, EmptyState, Skeleton } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FormField, Input } from '@/components/ui/field'
import { ApiError, api } from '@/lib/api/client'
import { boundariesQuery, queryKeys, settingsQuery } from '@/lib/api/queries'
import { asReceiverPosition } from '@/lib/api/types'
import type { Boundary, LatLon } from '@/lib/api/types'
import { tiledStyle } from '@/features/map/style'

setWorkerUrl(workerUrl)

const BASE_URL = import.meta.env.BASE_URL
// A property is metres to a couple of hundred metres across -- close enough
// to trace individual features, not so close the operator cannot see their
// own fence line for context.
const DRAW_ZOOM = 18
const FALLBACK_CENTER: [number, number] = [-98.5, 39.5]
const FALLBACK_ZOOM = 3.3

export function BoundariesPanel() {
  const boundaries = useQuery(boundariesQuery())
  const [adding, setAdding] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Geofence boundaries</CardTitle>
        <CardDescription>
          Draw a boundary on the map, then an alert rule can require a track to be inside it
          before it fires -- a rule for your own property, not every aircraft the sensors see.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {boundaries.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {boundaries.data && boundaries.data.boundaries.length === 0 && !adding ? (
              <EmptyState title="No boundaries yet">
                Draw one to use the &ldquo;within boundary&rdquo; condition on an alert rule.
              </EmptyState>
            ) : null}

            {boundaries.data?.boundaries.map((b) => (
              <BoundaryRow key={b.boundary_id} boundary={b} />
            ))}

            {adding ? (
              <BoundaryEditor onDone={() => setAdding(false)} />
            ) : (
              <Button variant="outline" onClick={() => setAdding(true)}>
                <PlusIcon className="size-4" aria-hidden />
                Draw a boundary
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function BoundaryRow({ boundary }: { boundary: Boundary }) {
  const queryClient = useQueryClient()
  const { preferences } = usePreferences()
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.boundaries })
  const remove = useMutation({
    mutationFn: () => api.deleteBoundary(boundary.boundary_id),
    onSuccess: invalidate,
  })

  if (editing) {
    return <BoundaryEditor boundary={boundary} onDone={() => setEditing(false)} />
  }

  return (
    <div className="border-border/60 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3">
      <span className="text-sm font-medium">{boundary.name}</span>
      <span className="text-muted-foreground text-2xs">{boundary.points.length} points</span>

      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
        {remove.error instanceof ApiError ? (
          <span className="text-down text-2xs" title={remove.error.message}>
            {remove.error.message}
          </span>
        ) : null}
        {confirmingDelete ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false)
                remove.mutate()
              }}
              disabled={remove.isPending}
            >
              Confirm delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              preferences.confirmDestructive ? setConfirmingDelete(true) : remove.mutate()
            }
            disabled={remove.isPending}
            aria-label={`Delete ${boundary.name}`}
          >
            <Trash2Icon className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}

/** Exported for its own test; the panel renders it directly. */
export function BoundaryEditor({
  boundary,
  onDone,
}: {
  boundary?: Boundary
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const { theme } = useTheme()
  const settings = useQuery(settingsQuery())
  const receiverPosition = asReceiverPosition(
    settings.data?.settings['map.receiver_position']?.value,
  )

  const [name, setName] = useState(boundary?.name ?? '')
  const [points, setPoints] = useState<LatLon[]>(boundary?.points ?? [])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  // Read inside the click handler via a ref, not the `points` state directly
  // -- the handler is attached once, when the map is created, and a state
  // closure captured then would keep appending to an empty array forever.
  const pointsRef = useRef(points)
  useEffect(() => {
    pointsRef.current = points
  }, [points])

  useEffect(() => {
    if (!containerRef.current) return
    const center: [number, number] = boundary?.points[0]
      ? [boundary.points[0].lon, boundary.points[0].lat]
      : receiverPosition
        ? [receiverPosition.lon, receiverPosition.lat]
        : FALLBACK_CENTER
    const zoom = boundary || receiverPosition ? DRAW_ZOOM : FALLBACK_ZOOM

    const map = new MapLibreMap({
      container: containerRef.current,
      style: tiledStyle(theme, BASE_URL),
      center,
      zoom,
      cooperativeGestures: true,
    })
    mapRef.current = map

    map.on('load', () => {
      map.addSource('boundary-draft', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'boundary-draft-fill',
        type: 'fill',
        source: 'boundary-draft',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.15 },
      })
      map.addLayer({
        id: 'boundary-draft-line',
        type: 'line',
        source: 'boundary-draft',
        paint: { 'line-color': '#22d3ee', 'line-width': 2 },
      })
      map.addLayer({
        id: 'boundary-draft-points',
        type: 'circle',
        source: 'boundary-draft',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 5, 'circle-color': '#22d3ee' },
      })
      redraw(map, pointsRef.current)
    })

    map.on('click', (e) => {
      const next = [...pointsRef.current, { lat: e.lngLat.lat, lon: e.lngLat.lng }]
      pointsRef.current = next
      setPoints(next)
      redraw(map, next)
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
    // Built once per mount. Re-centring on a prop change would yank the view
    // out from under an operator who has already started placing points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const undo = () => {
    const next = points.slice(0, -1)
    setPoints(next)
    if (mapRef.current) redraw(mapRef.current, next)
  }
  const clear = () => {
    setPoints([])
    if (mapRef.current) redraw(mapRef.current, [])
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { name, points }
      return boundary
        ? api.updateBoundary(boundary.boundary_id, body)
        : api.createBoundary(body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.boundaries })
      onDone()
    },
  })
  const error = save.error instanceof ApiError ? save.error : null
  const canSave = name.trim() !== '' && points.length >= 3

  return (
    <div className="border-border/60 space-y-3 rounded-md border p-3">
      {error ? (
        <Alert tone="error" title="Could not save the boundary">
          {error.message}
        </Alert>
      ) : null}

      <FormField label="Name">
        {(props) => (
          <Input
            {...props}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Back yard"
          />
        )}
      </FormField>

      <p className="text-muted-foreground text-2xs">
        Click the map to place each corner, in order. {points.length} point
        {points.length === 1 ? '' : 's'} placed
        {points.length > 0 && points.length < 3 ? ` -- at least 3 needed` : ''}.
      </p>

      <div
        ref={containerRef}
        className="h-[24rem] w-full overflow-hidden rounded-md"
        role="application"
        aria-label="Boundary drawing map"
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={undo}
          disabled={!points.length}
        >
          <Undo2Icon className="size-3.5" aria-hidden />
          Undo last point
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clear}
          disabled={!points.length}
        >
          Clear
        </Button>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || !canSave}
        >
          {save.isPending ? 'Saving…' : boundary ? 'Save' : 'Create'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Renders the drafted ring as a line/fill (once it has at least 3 points,
 * otherwise just the line the points-so-far make) plus a dot per vertex.
 *
 * The polygon is closed here, for drawing only -- the stored `points` never
 * repeats the first vertex, matching geofence.Boundary on the server.
 */
function redraw(map: MapLibreMap, points: LatLon[]) {
  const source = map.getSource('boundary-draft')
  if (!(source instanceof GeoJSONSource)) return

  const coords: [number, number][] = points.map((p) => [p.lon, p.lat])
  const features: GeoJSON.Feature[] = points.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: {},
  }))
  const first = coords[0]
  if (coords.length >= 2 && first) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [...coords, first] },
      properties: {},
    })
  }
  if (coords.length >= 3 && first) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...coords, first]] },
      properties: {},
    })
  }
  void source.setData({ type: 'FeatureCollection', features })
}

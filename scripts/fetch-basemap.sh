#!/usr/bin/env bash
# Cut a local Protomaps basemap for the operator UI.
#
# Two .pmtiles files in services/ui/public/tiles/ -- the detailed area extract
# plus a small whole-world overview the UI layers underneath it -- served by
# whatever already serves the app. No tile server, no proxy, no upstream, and
# -- unlike the satellite raster path -- no third-party imagery baked into an
# image you might publish. This is the only basemap option that is fully
# offline.
#
# Needs the `pmtiles` CLI: https://docs.protomaps.com/pmtiles/cli
#
#   ./scripts/fetch-basemap.sh <min-lon> <min-lat> <max-lon> <max-lat> [max-zoom]
#
# Example, roughly Seattle and its approaches:
#
#   ./scripts/fetch-basemap.sh -122.6 47.4 -122.1 47.8 14
#
# Then point the UI at it and rebuild:
#
#   VITE_BASEMAP_VECTOR_URL=/tiles/basemap.pmtiles
#
# Extracting reads only the ranges it needs out of the remote planet build, so
# a metropolitan area is tens of megabytes and a few minutes, not the 100+ GB
# the full planet would be.

set -euo pipefail

if [ "$#" -lt 4 ]; then
    sed -n '2,25p' "$0" | sed 's/^# \?//'  # keep the range in step with the header above
    exit 2
fi

MIN_LON="$1"; MIN_LAT="$2"; MAX_LON="$3"; MAX_LAT="$4"
# z14 has every road and building the display draws; the style has no labels
# and stops adding buildings below it, so deeper zooms cost size for detail
# nothing renders. Raise it only if you have changed the style to match.
MAX_ZOOM="${5:-14}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${CLASSG_BASEMAP_OUT:-$ROOT/services/ui/public/tiles/basemap.pmtiles}"

# Protomaps publishes a daily planet build at build.protomaps.com/YYYYMMDD.pmtiles
# and keeps roughly the last ten days. A hardcoded date is therefore guaranteed
# to 404 within a fortnight, so walk back from today until one answers.
# CLASSG_BASEMAP_SOURCE overrides this with any URL or local path the pmtiles
# CLI accepts, including your own build.
resolve_source() {
    if [ -n "${CLASSG_BASEMAP_SOURCE:-}" ]; then
        echo "$CLASSG_BASEMAP_SOURCE"
        return 0
    fi
    local day url offset
    for offset in $(seq 0 14); do
        # GNU date first, BSD/macOS second.
        day=$(date -u -d "-${offset} day" +%Y%m%d 2>/dev/null) ||
            day=$(date -u -v-"${offset}"d +%Y%m%d 2>/dev/null) ||
            return 1
        url="https://build.protomaps.com/${day}.pmtiles"
        if curl -fsI --max-time 20 "$url" >/dev/null 2>&1; then
            echo "$url"
            return 0
        fi
    done
    return 1
}

# `go install` names the binary after the module -- go-pmtiles -- while the
# published release archives call it pmtiles. Accept either rather than telling
# someone to run an install that produces a name this script then cannot find.
PMTILES=""
for candidate in pmtiles go-pmtiles; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PMTILES="$candidate"
        break
    fi
done
if [ -z "$PMTILES" ]; then
    cat >&2 <<'EOF'
pmtiles CLI not found. Either:

  go install github.com/protomaps/go-pmtiles@latest   (installs as `go-pmtiles`)

or download a release from https://github.com/protomaps/go-pmtiles/releases
and make sure $GOPATH/bin (or wherever you put it) is on PATH.
EOF
    exit 1
fi

if ! SOURCE="$(resolve_source)"; then
    echo "no Protomaps daily build found in the last 14 days." >&2
    echo "Set CLASSG_BASEMAP_SOURCE to a build URL or a local .pmtiles path." >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT")"
echo "Extracting $MIN_LON,$MIN_LAT..$MAX_LON,$MAX_LAT to z$MAX_ZOOM"
echo "  source: $SOURCE"
echo "  out:    $OUT"

"$PMTILES" extract "$SOURCE" "$OUT" \
    --bbox="$MIN_LON,$MIN_LAT,$MAX_LON,$MAX_LAT" \
    --maxzoom="$MAX_ZOOM"

# A bboxed extract keeps every zoom 0..max for any tile that INTERSECTS the
# box, and at z4 one tile spans most of a continent — so zoomed out, the
# extract renders as a part-filled rectangle floating in a void. The companion
# below is a bboxless whole-world cut at z6 (~43 MB) that the UI probes for at
# `<name>-world.pmtiles` and draws underneath; keep its --maxzoom in step with
# WORLD_MAX_ZOOM in services/ui/src/features/map/style.ts. Each extra zoom
# level roughly quadruples the size for detail the local extract already has.
WORLD_OUT="${CLASSG_BASEMAP_WORLD_OUT:-${OUT%.pmtiles}-world.pmtiles}"
"$PMTILES" extract "$SOURCE" "$WORLD_OUT" --maxzoom=6

echo
ls -lh "$OUT" "$WORLD_OUT"
cat <<EOF

Point the UI at it:

  VITE_BASEMAP_VECTOR_URL=/tiles/basemap.pmtiles

The UI probes the archive before choosing it and falls back to the satellite
raster, then to range rings, so a missing or truncated file degrades the map
rather than breaking it. Confirm which one you got from the attribution in the
bottom-right corner. The -world companion is probed the same way and simply
not drawn if it is missing; without it, zooming far out shows the extract as
a floating rectangle.
EOF

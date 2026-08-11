#!/usr/bin/env bash
# Download the OpenSky Network aircraft database for ADS-B contact naming.
#
# Turns "contact A1B2C3" into "N512UP, a Cessna 208". Read once at fusion
# startup from CLASSG_FUSION_AIRCRAFT_DB; the mapping from ICAO address to
# airframe does not change while an aircraft is overhead, so there is no live
# API call anywhere in this path and the uplink can be unplugged afterwards.
#
# Licensed CC-BY by the OpenSky Network. Gitignored: it is ~100 MB, it is
# somebody else's data, and a copy in git would be stale within a month.
#
#   ./scripts/fetch-aircraft-db.sh [output-path]
#
# OpenSky renames the export periodically -- it has been aircraftDatabase.csv
# and aircraft-database-complete-YYYY-MM.csv. Override the URL rather than
# editing this script:
#
#   CLASSG_AIRCRAFT_DB_URL=https://.../aircraft-database-complete-2026-08.csv \
#     ./scripts/fetch-aircraft-db.sh
#
# Browse what is currently published at https://opensky-network.org/datasets/metadata/

set -euo pipefail

URL="${CLASSG_AIRCRAFT_DB_URL:-https://opensky-network.org/datasets/metadata/aircraftDatabase.csv}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/data/aircraft-database.csv}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Fetching $URL"
echo "(around 100 MB; this is the only network call in the whole feature)"
if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$TMP" "$URL"
elif command -v wget >/dev/null 2>&1; then
    wget -O "$TMP" "$URL"
else
    echo "need curl or wget" >&2
    exit 1
fi

# The loader keys on the icao24 column by name. A file without one is not this
# database, whatever the URL said, and replacing a good copy with it would cost
# every contact its name for no visible reason.
if ! head -1 "$TMP" | grep -qi 'icao24'; then
    echo "downloaded file has no icao24 column; leaving $OUT alone" >&2
    head -3 "$TMP" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT")"
mv "$TMP" "$OUT"
trap - EXIT

ROWS=$(($(wc -l <"$OUT") - 1))
echo "Wrote $OUT ($ROWS rows)"
echo
echo "Point fusion at it:"
echo "  CLASSG_FUSION_AIRCRAFT_DB=$OUT"
echo
echo "The whole file is held in memory. On a small Pi, filter it down first --"
echo "the loader neither knows nor cares how the CSV was produced, as long as"
echo "it keeps the header row."

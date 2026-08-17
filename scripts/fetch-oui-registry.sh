#!/usr/bin/env bash
# Download the IEEE MA-L registry for Wi-Fi vendor fingerprinting (Class C).
#
# Feeds `oui_owner_patterns` in services/sensor-wifi/data/oui_fingerprints.yaml,
# which expands a vendor name into every OUI IEEE has actually assigned to them.
# Without this file those patterns are skipped and only the hand-listed OUIs
# apply -- the sensor still works, it just recognises fewer blocks.
#
# The result is deliberately gitignored. It is IEEE's data, about a megabyte,
# and it changes on the order of days; a copy in git would be stale, large, and
# not ours to redistribute.
#
#   ./scripts/fetch-oui-registry.sh [output-path]

set -euo pipefail

URL="${CLASSG_OUI_REGISTRY_URL:-https://standards-oui.ieee.org/oui/oui.csv}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/services/sensor-wifi/data/ieee-oui.csv}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Fetching $URL"
if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$TMP" "$URL"
elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$TMP" "$URL"
else
    echo "need curl or wget" >&2
    exit 1
fi

# Validate before replacing. IEEE has served an HTML error page at HTTP 200
# before, and a truncated or wrong file would quietly cost every expanded OUI
# without anything looking broken -- the sensor would simply detect less.
if ! head -1 "$TMP" | grep -qi 'Organization Name'; then
    echo "downloaded file has no 'Organization Name' column; leaving $OUT alone" >&2
    head -3 "$TMP" >&2
    exit 1
fi

ROWS=$(($(wc -l <"$TMP") - 1))
if [ "$ROWS" -lt 10000 ]; then
    echo "only $ROWS assignments; the real registry has tens of thousands" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT")"
mv "$TMP" "$OUT"
trap - EXIT

echo "Wrote $OUT ($ROWS assignments)"
echo
echo "Confirm the vendors in oui_fingerprints.yaml are actually in it:"
echo "  grep -ic dji '$OUT'"

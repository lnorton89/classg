#!/usr/bin/env bash
# Migrate a live .env to the ADR-0007 tier split.
#
#   ./scripts/migrate-env.sh              # apply, after backing up
#   ./scripts/migrate-env.sh --dry-run    # show what would change
#   ./scripts/migrate-env.sh path/to/.env
#
# What it does:
#   - removes the settings that now live in the database, seeded from
#     config/defaults.yaml
#   - reports each removal, and flags loudly when the value was CUSTOMISED,
#     because that one needs carrying over rather than just deleting
#   - fixes CLASSG_STORE=memory, which disagreed with both the Go default and
#     Compose and was the concrete bug ADR-0007 was written against
#   - adds the Tier 1 keys that are new (CLASSG_CONFIG_SEED)
#   - leaves secrets, bus topology, fusion, sensor-wifi, Vite and Compose
#     variables alone: only the API is tiered so far
#
# Idempotent: running it twice changes nothing the second time.

set -uo pipefail

DRY_RUN=0
ENV_FILE=""
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        -*) echo "unknown option: $arg" >&2; exit 2 ;;
        *)  ENV_FILE="$arg" ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo "no env file at $ENV_FILE" >&2
    echo "create one first:  make env" >&2
    exit 1
fi

# Moved settings: OLD_ENV_VAR | new dotted key | default value | mutable?
#
# `mutable` matters. An immutable setting is read once at startup by something
# that cannot be re-pointed while running, so the API refuses a runtime PUT
# against it. If such a value has been customised there is nowhere to move it to
# on a running system, so this script LEAVES IT ALONE rather than deleting a
# value with no way to restore it. It will report as source:"env", which is
# correct and visible.
MOVED_KEYS=(
    "CLASSG_VERSION|api.version|0.1.0|no"
    "CLASSG_UI_DIR|api.ui_dir|../ui/dist|no"
    "CLASSG_EXPOSE_OPERATOR_LOCATION|api.expose_operator_location|true|yes"
    "CLASSG_EXPECTED_SENSORS|sensors.expected|wifi-0:wifi|yes"
    "CLASSG_SENSOR_STALE_AFTER|sensors.stale_after|30s|yes"
    "CLASSG_SENSOR_RESTART_COMMAND|sensors.restart_command|systemctl restart %s|yes"
    "CLASSG_MAX_HISTORY|fusion.max_history|512|yes"
    "CLASSG_RETENTION_DETECTIONS|retention.detections|168h|yes"
    "CLASSG_RETENTION_TRACKS|retention.tracks|2160h|yes"
    "CLASSG_RETENTION_INTERVAL|retention.interval|1h|yes"
    "CLASSG_CAPTURE_DIR|capture.dir|captures|no"
    "CLASSG_CAPTURE_DURATION_S|capture.duration_s|120|yes"
    "CLASSG_CAPTURE_LABEL|capture.label|sensor-capture|yes"
    "CLASSG_CAPTURE_ALLOW_UNPRIVILEGED|capture.allow_unprivileged|false|yes"
    "CLASSG_SENSOR_WIFI_DIR|capture.sensor_wifi_dir|../sensor-wifi|no"
    "CLASSG_PYTHON|capture.python_bin|python3|no"
)

lookup() { # var -> "newkey|default|mutable", empty if not a moved key
    local want="$1" entry
    for entry in "${MOVED_KEYS[@]}"; do
        [ "${entry%%|*}" = "$want" ] && { echo "${entry#*|}"; return; }
    done
}

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

removed=0
customised=()
kept=()
plain=()

while IFS= read -r line || [ -n "$line" ]; do
    # Only touch assignments; comments and blanks pass through untouched.
    if [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)= ]]; then
        var="${BASH_REMATCH[1]}"
        meta="$(lookup "$var")"
        if [ -n "$meta" ]; then
            newkey="${meta%%|*}"
            rest="${meta#*|}"
            default="${rest%%|*}"
            mutable="${rest##*|}"
            value="${line#*=}"
            value="${value%\"}"; value="${value#\"}"   # tolerate quoted values

            if [ "$value" = "$default" ]; then
                plain+=("$var -> $newkey")
                removed=$((removed + 1))
                continue
            fi
            if [ "$mutable" = "yes" ]; then
                customised+=("$newkey|$value")
                removed=$((removed + 1))
                continue
            fi
            # Customised and immutable: keep it. Deleting would change behaviour
            # with no runtime way to put it back.
            kept+=("$var=$value  ($newkey is not runtime-changeable)")
        fi
    fi
    printf '%s\n' "$line"
done < "$ENV_FILE" > "$TMP"

# --- Tier 1 keys that did not exist before -----------------------------------
added=()
ensure() { # var, value, comment
    if ! grep -qE "^[[:space:]]*$1=" "$TMP"; then
        {
            printf '\n# %s\n' "$3"
            printf '%s=%s\n' "$1" "$2"
        } >> "$TMP"
        added+=("$1=$2")
    fi
}
ensure CLASSG_CONFIG_SEED "../../config/defaults.yaml" \
    "Tier 3 seed. Relative to services/api, where the binary runs."

# --- the original bug --------------------------------------------------------
fixed_store=0
if grep -qE '^[[:space:]]*CLASSG_STORE=memory[[:space:]]*$' "$TMP"; then
    sed -i 's|^[[:space:]]*CLASSG_STORE=memory[[:space:]]*$|CLASSG_STORE=libsql|' "$TMP"
    fixed_store=1
fi

# --- report ------------------------------------------------------------------
echo "ClassG .env migration -- $ENV_FILE"
echo

if [ "${#plain[@]}" -gt 0 ]; then
    echo "Removed (were at the default, nothing to carry over):"
    printf '  %s\n' "${plain[@]}"
    echo
fi

if [ "${#customised[@]}" -gt 0 ]; then
    echo "Removed, and these were CUSTOMISED -- re-apply them or they revert:"
    for entry in "${customised[@]}"; do
        printf '  %s = %s\n' "${entry%%|*}" "${entry#*|}"
    done
    echo
    echo "  Run these once the API is up (they are all runtime-changeable):"
    echo
    for entry in "${customised[@]}"; do
        printf '    curl -X PUT localhost:8081/api/v1/config/settings \\\n      -d '\''{"%s":"%s"}'\''\n' \
            "${entry%%|*}" "${entry#*|}"
    done
    echo
fi

if [ "${#kept[@]}" -gt 0 ]; then
    echo "KEPT in .env -- customised, but not changeable at runtime:"
    printf '  %s\n' "${kept[@]}"
    echo
    echo "  These stay as environment variables. They will report source:\"env\""
    echo "  and show read-only in the UI, which is correct. To move one into the"
    echo "  database instead, edit config/defaults.yaml and recreate the DB."
    echo
fi

[ "$fixed_store" -eq 1 ] && echo "Fixed CLASSG_STORE=memory -> libsql" && echo
if [ "${#added[@]}" -gt 0 ]; then
    echo "Added:"
    printf '  %s\n' "${added[@]}"
    echo
fi

if [ "$removed" -eq 0 ] && [ "${#added[@]}" -eq 0 ] && [ "$fixed_store" -eq 0 ]; then
    echo "Already migrated. Nothing to do."
    exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "--dry-run: no changes written."
    exit 0
fi

BACKUP="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
cp "$TMP" "$ENV_FILE"

echo "Written. Backup: $BACKUP"
echo
echo "Verify the tiers took effect -- source should now read seed or db, not env:"
echo "  curl -s localhost:8081/api/v1/config/settings | head -40"

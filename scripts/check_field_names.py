#!/usr/bin/env python3
"""Field-name extraction for check-mirrors.py: Go structs, TS interfaces, and
the JSON the deploy agents write by hand with printf.

Kept in its own file because the regexes here are backslash-heavy and writing
them through an intermediate shell has mangled them repeatedly -- twice badly
enough to leave an unterminated string literal behind.

Field NAMES only. Types either side are not comparable without a real parser,
and a renamed, added or dropped field is what actually breaks a consumer. Three
had already gone missing when this was written:

  - health.Sensor grew `optional` -- whether a sensor is hardware the unit may
    not have fitted -- and the UI interface never learned about it, so the
    difference between broken and never-fitted arrived and was discarded.
  - model.Capture has always sent `error`, the reason a capture failed, and the
    interface never declared it, so a failed capture rendered a red badge with
    its explanation sitting unread in the response.
  - classg-watchdog.sh publishes `wifi_tplink_adapter_present` for the second
    Wi-Fi adapter, and neither the Go struct that reads the file nor the panel
    that renders it had the field -- so on the one panel whose job is naming
    missing hardware, half the Wi-Fi hardware could not appear.

That last one is why the shell is in here too. Go and TypeScript at least fail
loudly on a typo; a printf writing a key nobody reads fails silently for ever.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TYPES_TS = "services/ui/src/lib/api/types.ts"

# Fields one side legitimately has alone, with the reason.
#
#   SensorHealth.config: GET /sensors adds it from httpapi's own sensorConfig
#       struct, so it is correctly absent from health.Sensor.
TS_ONLY_BY_DESIGN = {
    "SensorHealth": {"config"},
}


def _read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def go_fields(src: str, name: str, _seen: set[str] | None = None) -> set[str] | None:
    """JSON field names on a Go struct, following embedded structs.

    Embedding is not cosmetic here: deploy.Status is two lines of its own plus
    an embedded State holding the fourteen fields that actually reach the UI.
    A comparison that stopped at the outer struct would report every one of
    them as missing and be ignored as noise.
    """
    seen = _seen if _seen is not None else set()
    if name in seen:
        return set()
    seen.add(name)

    m = re.search(r"type " + re.escape(name) + r" struct \{(.*?)\n\}", src, re.S)
    if m is None:
        return None

    out: set[str] = set()
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        tag = re.search(r'json:"([^"]+)"', line)
        if tag:
            field = tag.group(1).split(",")[0]
            if field and field != "-":
                out.add(field)
            continue
        # A bare capitalised identifier on its own line is an embedded struct.
        if re.fullmatch(r"[A-Z][A-Za-z0-9_]*", line):
            nested = go_fields(src, line, seen)
            if nested:
                out |= nested
    return out


def ts_fields(src: str, name: str) -> set[str] | None:
    """Property names on an exported TS interface."""
    m = re.search(r"export interface " + re.escape(name) + r" \{(.*?)\n\}", src, re.S)
    if m is None:
        return None
    # Strip comments first, or a field name mentioned in prose counts as a field.
    body = re.sub(r"/\*.*?\*/", "", m.group(1), flags=re.S)
    body = re.sub(r"//.*", "", body)
    names = set(re.findall(r"^\s*([a-zA-Z0-9_]+)\??:", body, re.M))
    return names - TS_ONLY_BY_DESIGN.get(name, set())


def printf_json_keys(src: str, marker: str) -> set[str] | None:
    """JSON keys a shell script writes with printf, in the block after `marker`.

    The deploy agents build their state documents a printf at a time rather
    than through jq, which is a dependency neither Pi image is guaranteed to
    have. Every one of those lines looks like:

        printf '  "last_result": "%s",\\n' "$result"

    Bounded to the block that starts at `marker` and ends at the redirect that
    closes it, so an unrelated printf elsewhere in the script cannot leak in.
    """
    start = src.find(marker)
    if start < 0:
        return None
    end = src.find('} > "$STATE_JSON.tmp"', start)
    if end < 0:
        return None
    keys = set(re.findall(r"printf\s+'\s*\"([a-z0-9_]+)\":", src[start:end]))
    return keys or None


def go_vs_ts(go_file: str, go_name: str, ts_name: str):
    """(go_fields, ts_fields, error) for one Go struct against one interface."""
    go = go_fields(_read(go_file), go_name)
    ts = ts_fields(_read(TYPES_TS), ts_name)
    if go is None or ts is None:
        return None, None, f"could not parse {go_name} or {ts_name}; has the shape changed?"
    return sorted(go), sorted(ts), None


def shell_vs_go(sh_file: str, marker: str, go_file: str, go_name: str):
    """(shell_keys, go_fields, error) for a hand-written state document."""
    sh = printf_json_keys(_read(sh_file), marker)
    go = go_fields(_read(go_file), go_name)
    if sh is None or go is None:
        return None, None, f"could not parse {sh_file} or {go_name}; has the shape changed?"
    return sorted(sh), sorted(go), None

#!/usr/bin/env python3
"""Compare Go response structs' JSON field names against the UI's interfaces.

Imported by check-mirrors.py. Kept in its own file because the regexes here are
backslash-heavy and writing them through an intermediate shell has mangled them
repeatedly -- twice badly enough to leave an unterminated string literal behind.

The UI hand-describes the API's JSON in TypeScript. Nothing checked those
descriptions, and two fields had already gone missing:

  - health.Sensor grew `optional` -- whether a sensor is hardware the unit may
    not have fitted -- and the interface never learned about it, so the
    difference between broken and never-fitted arrived and was discarded.
  - model.Capture has always sent `error`, the reason a capture failed, and the
    interface never declared it, so a failed capture rendered a red badge with
    its explanation sitting unread in the response.

Field NAMES only. The types either side are not comparable without a Go parser,
and a renamed or added field is what actually breaks a consumer.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# Fields one side legitimately has alone, with the reason.
#
#   config: GET /sensors adds it from httpapi's own sensorConfig struct, so it
#           is correctly absent from health.Sensor.
TS_ONLY_BY_DESIGN = {
    "SensorHealth": {"config"},
    "Capture": set(),
}


def _go_fields(src: str, name: str) -> list[str] | None:
    m = re.search(r"type " + re.escape(name) + r" struct \{(.*?)\n\}", src, re.S)
    if not m:
        return None
    out = set()
    for tag in re.findall(r'json:"([^"]+)"', m.group(1)):
        field = tag.split(",")[0]
        if field and field != "-":
            out.add(field)
    return sorted(out)


def _ts_fields(src: str, name: str) -> list[str] | None:
    m = re.search(r"export interface " + re.escape(name) + r" \{(.*?)\n\}", src, re.S)
    if not m:
        return None
    # Strip comments first, or a field name mentioned in prose counts as a field.
    body = re.sub(r"/\*.*?\*/", "", m.group(1), flags=re.S)
    body = re.sub(r"//.*", "", body)
    names = set(re.findall(r"^\s*([a-zA-Z0-9_]+)\??:", body, re.M))
    return sorted(names - TS_ONLY_BY_DESIGN.get(name, set()))


def _pair(go_file: str, go_name: str, ts_name: str) -> tuple[list[str], list[str], str | None]:
    go_src = (REPO / go_file).read_text(encoding="utf-8")
    ts_src = (REPO / "services/ui/src/lib/api/types.ts").read_text(encoding="utf-8")
    go = _go_fields(go_src, go_name)
    ts = _ts_fields(ts_src, ts_name)
    if go is None or ts is None:
        return [], [], f"could not parse {go_name} or {ts_name}; has the shape changed?"
    return go, ts, None


def sensor_field_names() -> tuple[list[str], list[str], str | None]:
    """api health.Sensor -> UI SensorHealth."""
    return _pair("services/api/internal/health/health.go", "Sensor", "SensorHealth")


def capture_field_names() -> tuple[list[str], list[str], str | None]:
    """api model.Capture -> UI Capture."""
    return _pair("services/api/internal/model/model.go", "Capture", "Capture")

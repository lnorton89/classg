#!/usr/bin/env python3
"""Compare api health.Sensor's JSON field names against the UI's SensorHealth.

Imported by check-mirrors.py. Kept in its own file because the regexes here are
backslash-heavy and this project's tooling has already mangled them twice when
they were written through an intermediate shell.

The /health sensors array is hand-described in TypeScript, nothing checked it,
and a field had already gone missing: Go grew `optional` -- "declared as
hardware the unit may not have fitted" -- and the UI type never learned about
it, so the difference between a sensor that is broken and one that was never
fitted arrived on every response and was discarded.

Field NAMES only. The types either side are not comparable without a Go parser,
and a renamed or added field is what actually breaks a consumer.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# `config` is added by GET /sensors from a different struct (httpapi
# sensorConfig), so it is legitimately absent from health.Sensor.
TS_ONLY_BY_DESIGN = {"config"}


def sensor_field_names() -> tuple[list[str], list[str], str | None]:
    """Return (go_fields, ts_fields, error)."""
    go_src = (REPO / "services/api/internal/health/health.go").read_text(encoding="utf-8")
    ts_src = (REPO / "services/ui/src/lib/api/types.ts").read_text(encoding="utf-8")

    go_block = re.search(r"type Sensor struct \{(.*?)\n\}", go_src, re.S)
    ts_block = re.search(r"export interface SensorHealth \{(.*?)\n\}", ts_src, re.S)
    if not go_block or not ts_block:
        return [], [], "could not parse a copy; has the shape changed?"

    go_fields = sorted(set(re.findall(r'json:"([a-z0-9_]+)', go_block.group(1))))

    # Strip comments first, or a field name mentioned in prose counts as a field.
    body = re.sub(r"/\*.*?\*/", "", ts_block.group(1), flags=re.S)
    body = re.sub(r"//.*", "", body)
    ts_fields = sorted(
        f
        for f in set(re.findall(r"^\s*([a-z0-9_]+)\??:", body, re.M))
        if f not in TS_ONLY_BY_DESIGN
    )
    return go_fields, ts_fields, None

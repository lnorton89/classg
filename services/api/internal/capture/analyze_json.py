"""Emit classg_wifi's capture analysis as JSON.

This adapter lives in services/api because `classg_wifi.cli analyze` renders a
text report and the API contract requires structured JSON
(GET /captures/{id}/report says "not the rendered text"). It imports the same
analyze_pcap() the CLI does, so it is the same pipeline, not a reimplementation.

Delete this file if a `--json` flag is ever added to classg_wifi.cli analyze;
internal/capture/analyze.go should then call that instead.

Every field access is defensive. The DJI and ODID dataclasses are the part of
the tree that changes most often as firmware variants are discovered, and a
report that omits one field is far more useful than one that raises.
"""

from __future__ import annotations

import json
import statistics
import sys
from typing import Any


def _g(obj: Any, name: str, default: Any = None) -> Any:
    return getattr(obj, name, default) if obj is not None else default


def _odid(p: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"protocol_version": _g(p, "protocol_version")}
    basic = _g(p, "basic_id")
    if basic is not None:
        out["basic_id"] = {
            "serial": _g(basic, "uas_id"),
            "id_type": _g(basic, "id_type"),
            "ua_type": _g(basic, "ua_type"),
            "manufacturer_code": _g(basic, "manufacturer_code"),
            "vendor": _g(basic, "vendor"),
        }
    basics = _g(p, "basic_ids") or []
    if len(basics) > 1:
        out["basic_id_count"] = len(basics)
        out["basic_id_types"] = [_g(b, "id_type") for b in basics]
    loc = _g(p, "location")
    if loc is not None:
        out["location"] = {
            "status": _g(loc, "status"),
            "lat": _g(loc, "lat"),
            "lon": _g(loc, "lon"),
            "alt_geodetic_m": _g(loc, "alt_geodetic_m"),
            "alt_pressure_m": _g(loc, "alt_pressure_m"),
            "height_m": _g(loc, "height_m"),
            "height_is_agl": _g(loc, "height_is_agl"),
            "speed_mps": _g(loc, "speed_mps"),
            "track_deg": _g(loc, "track_deg"),
            "vertical_speed_mps": _g(loc, "vertical_speed_mps"),
        }
    op = _g(p, "operator_id")
    if op is not None:
        out["operator_id"] = _g(op, "operator_id")
    sysmsg = _g(p, "system")
    if sysmsg is not None and _g(sysmsg, "operator_lat") is not None:
        out["operator_location"] = {
            "lat": _g(sysmsg, "operator_lat"),
            "lon": _g(sysmsg, "operator_lon"),
        }
    unknown = _g(p, "unknown_types")
    if unknown:
        out["unknown_message_types"] = sorted(set(unknown))
    return out


def _dji(t: Any) -> dict[str, Any]:
    from classg_wifi.parsers import dji as dji_mod

    out: dict[str, Any] = {
        "version": _g(t, "version"),
        "product_type": _g(t, "product_type"),
        "serial": _g(t, "serial"),
        "lat": _g(t, "lat"),
        "lon": _g(t, "lon"),
        "gps_valid": _g(t, "gps_valid"),
        "in_air": _g(t, "in_air"),
        "motors_on": _g(t, "motors_on"),
        "home_point_set": _g(t, "home_point_set"),
    }
    if _g(t, "operator_lat") is not None:
        out["operator_location"] = {"lat": _g(t, "operator_lat"), "lon": _g(t, "operator_lon")}
    if _g(t, "home_lat") is not None:
        out["home_point"] = {"lat": _g(t, "home_lat"), "lon": _g(t, "home_lon")}

    scales = getattr(dji_mod, "SCALES", {})
    raw = _g(t, "raw", {}) or {}
    rows = [
        ("altitude", "altitude", _g(t, "altitude_m"), "altitude_m", "m"),
        ("height", "height", _g(t, "height_m"), "height_m", "m"),
        ("v_north", "v_north", _g(t, "v_north_mps"), "velocity_mps", "m/s"),
        ("v_east", "v_east", _g(t, "v_east_mps"), "velocity_mps", "m/s"),
        ("v_up", "v_up", _g(t, "v_up_mps"), "velocity_mps", "m/s"),
        ("pitch", "pitch", _g(t, "pitch_deg"), "attitude_deg", "deg"),
        ("roll", "roll", _g(t, "roll_deg"), "attitude_deg", "deg"),
        ("yaw", "yaw", _g(t, "yaw_deg"), "attitude_deg", "deg"),
    ]
    out["calibration"] = [
        {
            "field": name,
            "raw": raw.get(raw_key),
            "decoded": decoded,
            "unit": unit,
            "scale": scales.get(scale_key),
        }
        for name, raw_key, decoded, scale_key, unit in rows
    ]
    return out


def main(path: str) -> int:
    from classg_wifi.analyze import analyze_pcap, summarize_channels

    result = analyze_pcap(path)
    drones = []
    for d in result.drones:
        entry: dict[str, Any] = {
            "mac": _g(d, "mac"),
            "ssid": _g(d, "ssid"),
            "channels": sorted(_g(d, "channels") or []),
            "odid_beacons": _g(d, "odid_count", 0),
            "dji_beacons": _g(d, "dji_count", 0),
        }
        rssi = _g(d, "rssi") or []
        if rssi:
            entry["rssi_dbm"] = {
                "min": min(rssi),
                "max": max(rssi),
                "median": statistics.median(rssi),
            }
        intervals = d.intervals_ms() if hasattr(d, "intervals_ms") else []
        if intervals:
            median = statistics.median(intervals)
            entry["beacon_interval_ms"] = {
                "median": median,
                "min": min(intervals),
                "max": max(intervals),
                "n": len(intervals),
            }
            # The ~1 Hz assumption drives the whole channel dwell budget, so
            # the measured rate is the single most valuable number here.
            entry["beacon_rate_hz"] = round(1000.0 / median, 3) if median else None
        if _g(d, "last_odid") is not None:
            entry["odid"] = _odid(d.last_odid)
        if _g(d, "last_dji") is not None:
            entry["dji"] = _dji(d.last_dji)
        purpose = _g(d, "dji_purpose")
        if purpose is not None:
            entry["dji_flight_purpose"] = _g(purpose, "purpose")
        drones.append(entry)

    report = {
        "frames": result.frames,
        "beacons": result.beacons,
        "parse_errors": result.parse_errors,
        "transmitters": len(result.transmitters),
        "drone_transmitters": len(result.drones),
        "beacons_per_channel": {str(k): v for k, v in summarize_channels(result).items()},
        "drones": drones,
    }
    json.dump(report, sys.stdout, default=str)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: analyze_json.py <pcap>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))

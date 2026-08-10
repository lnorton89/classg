"""Build schema-conformant Detection messages from parsed frames.

The only place in sensor-wifi that knows the wire schema. Parsers stay pure and
protocol-shaped; this module translates them into the cross-service contract in
schemas/detection.schema.json.

Sensors report observations only. No confidence, no track association, no threat
assessment - those are fusion's job (docs/architecture/data-model.md).
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Any

from .parsers.dji import DjiFlightPurpose, DjiTelemetry
from .parsers.dot11 import Beacon
from .parsers.odid import OdidPayload

SCHEMA_VERSION = "1.0"

_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _ulid(rand_bytes: bytes, ts_ms: int | None = None) -> str:
    """Minimal ULID: 48-bit timestamp + 80 bits of randomness, Crockford base32."""
    if ts_ms is None:
        ts_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    value = (ts_ms << 80) | int.from_bytes(rand_bytes[:10].ljust(10, b"\x00"), "big")
    out = []
    for _ in range(26):
        out.append(_ULID_ALPHABET[value & 0x1F])
        value >>= 5
    return "".join(reversed(out))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _position(lat: float | None, lon: float | None, **extra: float | None) -> dict | None:
    """Positions are all-or-nothing. lat/lon of 0,0 is already normalised to None
    by the parsers - see odid._decode_latlon."""
    if lat is None or lon is None:
        return None
    return {"lat": lat, "lon": lon, **extra}


def _base(
    sensor_id: str,
    detection_class: str,
    beacon: Beacon,
    rand: bytes,
    raw: bytes,
    parser: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "detection_id": _ulid(rand),
        "ts": _now_iso(),
        "sensor_id": sensor_id,
        "sensor_kind": "wifi",
        "detection_class": detection_class,
        "rf": {
            "freq_hz": beacon.freq_mhz * 1_000_000 if beacon.freq_mhz else None,
            "channel": _freq_to_channel(beacon.freq_mhz),
            "rssi_dbm": beacon.rssi_dbm,
            "bandwidth_hz": 20_000_000,
        },
        "raw": {
            "encoding": "base64",
            "bytes": base64.b64encode(raw).decode("ascii"),
            "parser": parser,
        },
    }


def _freq_to_channel(freq_mhz: int | None) -> int | None:
    if freq_mhz is None:
        return None
    if 2412 <= freq_mhz <= 2472:
        return (freq_mhz - 2412) // 5 + 1
    if freq_mhz == 2484:
        return 14
    if 5170 <= freq_mhz <= 5895:
        return (freq_mhz - 5000) // 5
    return None


def from_odid(sensor_id: str, beacon: Beacon, payload: OdidPayload,
              raw: bytes, rand: bytes) -> dict[str, Any]:
    """Class A - ASTM F3411 Remote ID over Wi-Fi Beacon."""
    d = _base(sensor_id, "A", beacon, rand, raw, f"odid/{payload.protocol_version}")

    identity: dict[str, Any] = {"mac": beacon.transmitter}
    if payload.basic_id:
        identity["serial"] = payload.basic_id.uas_id
        identity["id_type"] = payload.basic_id.id_type
        identity["ua_type"] = payload.basic_id.ua_type
    if payload.operator_id:
        identity["operator_id"] = payload.operator_id.operator_id
    if payload.self_id:
        identity["self_id"] = payload.self_id.description
    d["identity"] = identity

    if payload.location:
        loc = payload.location
        d["position"] = _position(
            loc.lat, loc.lon,
            alt_geodetic_m=loc.alt_geodetic_m,
            alt_pressure_m=loc.alt_pressure_m,
            height_agl_m=loc.height_m if loc.height_is_agl else None,
            h_accuracy_m=loc.h_accuracy_m,
            v_accuracy_m=loc.v_accuracy_m,
        )
        d["kinematics"] = {
            "speed_mps": loc.speed_mps,
            "track_deg": loc.track_deg,
            "vertical_speed_mps": loc.vertical_speed_mps,
        }

    if payload.system:
        sysmsg = payload.system
        d["operator"] = _position(
            sysmsg.operator_lat, sysmsg.operator_lon, alt_m=sysmsg.operator_alt_m
        )

    return d


def from_dji(sensor_id: str, beacon: Beacon,
             payload: DjiTelemetry | DjiFlightPurpose,
             raw: bytes, rand: bytes) -> dict[str, Any]:
    """Class B - DJI Wi-Fi DroneID."""
    if isinstance(payload, DjiFlightPurpose):
        d = _base(sensor_id, "B", beacon, rand, raw, "dji/0x11")
        d["identity"] = {
            "mac": beacon.transmitter,
            "serial": payload.serial,
            "self_id": payload.purpose,
            "vendor_hint": "dji",
        }
        return d

    d = _base(sensor_id, "B", beacon, rand, raw, "dji/0x10")
    d["identity"] = {
        "mac": beacon.transmitter,
        "serial": payload.serial,
        "id_type": "serial_ansi_cta_2063",
        "vendor_hint": "dji",
    }
    d["position"] = _position(
        payload.lat, payload.lon,
        alt_geodetic_m=payload.altitude_m,
        height_agl_m=payload.height_m,
    )
    d["kinematics"] = {
        "speed_mps": payload.speed_mps,
        "track_deg": payload.track_deg,
        "vertical_speed_mps": payload.v_up_mps,
    }
    d["operator"] = _position(payload.operator_lat, payload.operator_lon)
    return d


def from_fingerprint(sensor_id: str, beacon: Beacon, vendor: str,
                     reason: str, rand: bytes) -> dict[str, Any]:
    """Class C - Wi-Fi OUI/SSID fingerprint.

    Weakest evidence class by design. MAC randomisation and OUI reassignment both
    produce false positives, so fusion caps this at 0.10 confidence and it can
    never on its own promote a track to CONFIRMED.
    """
    d = _base(sensor_id, "C", beacon, rand, b"", f"fingerprint/{reason}")
    d["identity"] = {"mac": beacon.transmitter, "vendor_hint": vendor}
    d["raw"] = None
    return d

"""Every detection the sensor emits must validate against schemas/detection.schema.json.

The schema is the cross-language contract: Go, Rust and TypeScript all read it.
CI already checked that the schema file is well-formed and that a hand-written
reference detection passes it, which proves the schema is valid -- not that this
service obeys it. A field renamed in the pipeline, or an extra key added for
convenience, would have sailed through both checks and broken the consumers.

So these run REAL captured bytes through the REAL pipeline and validate what
comes out. `additionalProperties: false` in the schema means an undeclared key
fails here rather than at a Go unmarshal on the other side of the bus.
"""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from classg_wifi.bus import heartbeat_message
from classg_wifi.parsers import dji, odid
from classg_wifi.pipeline import Pipeline

from .synthetic import (
    RT_DBM_ANTSIGNAL,
    RT_FLAGS,
    RT_RATE,
    beacon_frame,
    radiotap,
)

SCHEMA_FILE = Path(__file__).parents[3] / "schemas" / "detection.schema.json"
HEARTBEAT_SCHEMA_FILE = Path(__file__).parents[3] / "schemas" / "heartbeat.schema.json"
VECTOR_FILE = Path(__file__).parent / "vectors" / "dji-mini-5-pro-2026-08-10.json"


def _validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(SCHEMA_FILE.read_text()))


def _real_odid_ies() -> list[bytes]:
    payload = json.loads(VECTOR_FILE.read_text())
    return [base64.b64decode(v["ie_b64"]) for v in payload["vectors"] if v["kind"] == "odid"]


def _detections_from_real_frames() -> list[dict[str, Any]]:
    pipeline = Pipeline(sensor_id="wifi-0")
    out: list[dict[str, Any]] = []
    for ie in _real_odid_ies():
        frame = beacon_frame(vendor_ies=[ie])
        out.extend(pipeline.process_frame(frame))
    return out


def test_the_schema_file_is_reachable():
    # A wrong relative path would make every test below vacuously pass.
    assert SCHEMA_FILE.exists(), f"schema not found at {SCHEMA_FILE}"


@pytest.mark.skipif(not VECTOR_FILE.exists(), reason="real-capture vectors not present")
def test_real_captured_frames_produce_detections():
    # Guards the same vacuous-pass failure from the other end: validating an
    # empty list proves nothing at all.
    assert _detections_from_real_frames(), "the real vectors produced no detections"


@pytest.mark.skipif(not VECTOR_FILE.exists(), reason="real-capture vectors not present")
def test_every_detection_from_real_frames_validates():
    validator = _validator()
    for detection in _detections_from_real_frames():
        errors = sorted(validator.iter_errors(detection), key=lambda e: e.json_path)
        assert not errors, (
            f"detection violates the contract at {errors[0].json_path}: "
            f"{errors[0].message}\n{json.dumps(detection, indent=2, default=str)}"
        )


def test_a_synthetic_detection_validates():
    # Runs with or without the captured vectors, so the contract stays covered
    # on a checkout that has never seen the hardware.
    pipeline = Pipeline(sensor_id="wifi-0")
    detections = list(pipeline.process_frame(beacon_frame(ssid="Mavic-A1B2C3")))
    validator = _validator()
    for detection in detections:
        errors = list(validator.iter_errors(detection))
        assert not errors, f"{errors[0].json_path}: {errors[0].message}"


def test_the_validator_actually_rejects_something():
    # If the schema were permissive -- or the wrong file -- everything above
    # would pass while checking nothing.
    validator = _validator()
    assert list(validator.iter_errors({"detection_class": "Z"})), (
        "the schema accepted an obviously invalid detection"
    )


# ---------------------------------------------------------------------------
# Hostile radio input.
#
# Everything above validates well-formed frames -- real captures and a sane
# synthetic -- which is exactly how five schema violations reachable from
# crafted frames survived: fusion does a plain json.Unmarshal with no
# validation, so an invalid detection sails silently downstream. Each case
# below was reproduced through the real pipeline before being fixed, and each
# is a frame anyone with a radio can put on the air.
# ---------------------------------------------------------------------------


def _odid_vendor_ie(*messages: bytes) -> bytes:
    pack = bytes([(0xF << 4) | 2, 25, len(messages)]) + b"".join(messages)
    return odid.ODID_OUI + bytes([odid.ODID_VENDOR_TYPE, 0x00]) + pack


def _odid_basic_id(id_type_code: int) -> bytes:
    header = bytes([(0x0 << 4) | 2])
    return header + bytes([(id_type_code << 4) | 2]) + b"1596F3B24C5D7E8F9A0B".ljust(23, b"\x00")


def _odid_location(raw_direction: int, ew_segment: bool) -> bytes:
    p = bytearray(24)
    p[0] = (2 << 4) | (0b010 if ew_segment else 0)  # airborne, E/W segment bit
    p[1] = raw_direction
    struct.pack_into("<ii", p, 4, int(47.3769 * 1e7), int(8.5417 * 1e7))
    return bytes([(0x1 << 4) | 2]) + bytes(p)


def _dji_telemetry_ie(lat_deg: float, lon_deg: float) -> bytes:
    p = bytearray()
    p += bytes([0x02])
    p += struct.pack("<HH", 42, 0x000F)
    p += b"1581F5FMD234A00A".ljust(16, b"\x00")
    p += struct.pack("<ii", int(lon_deg * dji.RAD_SCALE), int(lat_deg * dji.RAD_SCALE))
    p += struct.pack("<hh", 120, 100)
    p += struct.pack("<hhh", 50, -20, 5)
    p += struct.pack("<hhh", 0, 0, 900)
    # Operator and home carry the same out-of-range latitude.
    p += struct.pack("<ii", int(lat_deg * dji.RAD_SCALE), int(lon_deg * dji.RAD_SCALE))
    p += struct.pack("<ii", int(lon_deg * dji.RAD_SCALE), int(lat_deg * dji.RAD_SCALE))
    p += bytes([0x1A, 0x00])
    return dji.DJI_OUI + bytes([0x00, dji.SUBCMD_TELEMETRY]) + bytes(p)


def _dji_flight_purpose_ie(purpose: bytes) -> bytes:
    body = b"1581F5FMD234A00A" + bytes([len(purpose)]) + purpose
    return dji.DJI_OUI + bytes([0x00, dji.SUBCMD_FLIGHT_PURPOSE]) + body


def _radiotap_without_channel(rssi_dbm: int = -60) -> bytes:
    present = RT_FLAGS | RT_RATE | RT_DBM_ANTSIGNAL
    body = struct.pack("<BBb", 0x00, 0x02, rssi_dbm)
    return struct.pack("<BBHI", 0, 0, 8 + len(body), present) + body


def _validated(frame: bytes) -> list[dict[str, Any]]:
    """Run one frame through the real pipeline and insist the output validates."""
    pipeline = Pipeline(sensor_id="wifi-0")
    detections = list(pipeline.process_frame(frame))
    assert detections, "the crafted frame produced no detection to validate"
    validator = _validator()
    for detection in detections:
        errors = sorted(validator.iter_errors(detection), key=lambda e: e.json_path)
        assert not errors, (
            f"detection violates the contract at {errors[0].json_path}: "
            f"{errors[0].message}\n{json.dumps(detection, indent=2, default=str)}"
        )
    return detections


class TestHostileFramesStillValidate:
    def test_reserved_basic_id_type_becomes_null_not_unknown(self):
        # id_type codes 5-15 are reserved; the parser reports them as
        # "unknown", which is not in the schema enum. Null is.
        frame = beacon_frame(vendor_ies=[_odid_vendor_ie(_odid_basic_id(5))])
        (detection,) = _validated(frame)
        assert detection["identity"]["id_type"] is None

    def test_direction_180_with_ew_bit_does_not_emit_360(self):
        # Raw direction 180 plus the E/W segment bit decoded to exactly 360.0,
        # which track_deg's exclusiveMaximum rejects. 180 is out of range on
        # the wire (valid raw headings are 0-179), so it must decode to null.
        frame = beacon_frame(
            vendor_ies=[_odid_vendor_ie(_odid_basic_id(1), _odid_location(180, ew_segment=True))]
        )
        (detection,) = _validated(frame)
        assert detection["kinematics"]["track_deg"] is None

    def test_a_valid_direction_with_ew_bit_still_decodes(self):
        # The fix must not eat the top of the legitimate range.
        frame = beacon_frame(
            vendor_ies=[_odid_vendor_ie(_odid_basic_id(1), _odid_location(179, ew_segment=True))]
        )
        (detection,) = _validated(frame)
        assert detection["kinematics"]["track_deg"] == 359.0

    def test_radiotap_without_a_channel_field_omits_freq_hz(self):
        # freq_hz is a non-nullable integer in the schema and not required;
        # a header with no channel field must omit it rather than send null.
        with_channel = beacon_frame(vendor_ies=[_odid_vendor_ie(_odid_basic_id(1))])
        frame = _radiotap_without_channel() + with_channel[len(radiotap()):]
        (detection,) = _validated(frame)
        assert "freq_hz" not in detection["rf"]

    def test_dji_latitude_past_90_yields_no_position(self):
        # _angle bounded latitude to +/-180, so a crafted raw latitude of
        # ~170 degrees became position.lat 169.99 -- past the schema's 90 cap.
        # The same bound protects operator.lat.
        frame = beacon_frame(vendor_ies=[_dji_telemetry_ie(lat_deg=170.0, lon_deg=8.5417)])
        (detection,) = _validated(frame)
        assert detection["position"] is None
        assert detection["operator"] is None

    def test_dji_flight_purpose_is_truncated_to_the_schema_cap(self):
        # The 0x11 payload allows ~230 bytes of description; self_id caps at 64.
        frame = beacon_frame(vendor_ies=[_dji_flight_purpose_ie(b"A" * 120)])
        (detection,) = _validated(frame)
        assert detection["identity"]["self_id"] == "A" * 64


class TestHeartbeatConformance:
    """Heartbeats now have a schema too -- the two sensors used to disagree on
    `ts` (epoch float here, RFC3339 in sensor-sdr) and only the API's FlexTime
    kept that from being a wire mismatch."""

    def test_the_wifi_heartbeat_validates(self):
        validator = Draft202012Validator(json.loads(HEARTBEAT_SCHEMA_FILE.read_text()))
        msg = heartbeat_message("wifi-0", True, 12, 0, {"iface": "wlan1"})
        errors = list(validator.iter_errors(msg))
        assert not errors, f"{errors[0].json_path}: {errors[0].message}"
        assert msg["ts"].endswith("Z"), "ts must be RFC3339, not an epoch float"

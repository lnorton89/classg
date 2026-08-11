"""Regression tests against a hand-built, fully synthetic ODID vector.

`vectors/sample.json` contains no real capture bytes -- every field was
constructed field-by-field to match the wire layout in `classg_wifi/parsers/
odid.py`. Unlike `test_vectors_real.py`, this file is always committed and
always runs: it is the regression net for contributors who don't have a real
capture of their own, so a parser change can't silently go unexercised in CI.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from classg_wifi.parsers import odid

VECTOR_FILE = Path(__file__).parent / "vectors" / "sample.json"


def _vectors() -> list[dict]:
    return json.loads(VECTOR_FILE.read_text())["vectors"]


def _ie(kind: str) -> bytes:
    (v,) = [v for v in _vectors() if v["kind"] == kind]
    return base64.b64decode(v["ie_b64"])


def test_sample_vector_parses_without_error():
    payload = odid.parse_vendor_ie(_ie("odid"))
    assert payload is not None
    assert payload.basic_id is not None
    assert payload.location is not None
    assert payload.system is not None


def test_sample_serial_roundtrips():
    payload = odid.parse_vendor_ie(_ie("odid"))
    assert payload.basic_id.uas_id == "SAMPLE0001"
    assert payload.basic_id.id_type == "serial_ansi_cta_2063"
    assert payload.basic_id.ua_type == "multirotor"


def test_sample_location_and_operator_position_decode():
    payload = odid.parse_vendor_ie(_ie("odid"))
    assert payload.location.lat == 12.345678
    assert payload.location.lon == -98.7654321
    assert payload.system.operator_lat == 12.0
    assert payload.system.operator_lon == -98.0


def test_sample_ssid_embeds_the_serial():
    ssid = _vectors()[0]["ssid"]
    assert ssid == "RID-SAMPLE0001"

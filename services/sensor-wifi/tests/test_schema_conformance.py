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
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from classg_wifi.pipeline import Pipeline

from .synthetic import beacon_frame

SCHEMA_FILE = Path(__file__).parents[3] / "schemas" / "detection.schema.json"
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

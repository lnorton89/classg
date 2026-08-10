"""Regression tests against REAL bytes from a DJI Mini 5 Pro.

Vectors captured 2026-08-10 (`captures/20260810-141223-dji-first-flight.pcap`,
gitignored) and extracted by `tests/extract_vectors.py`. The vectors themselves
ARE committed: they are small, they contain only the drone's own broadcast, and
they are the regression net that catches a parser change quietly altering decode
results on known-good data.

Synthetic frames prove the parser handles what we thought of. These prove it
handles what the aircraft actually sends.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from classg_wifi.parsers import odid

VECTOR_FILE = Path(__file__).parent / "vectors" / "dji-mini-5-pro-2026-08-10.json"

pytestmark = pytest.mark.skipif(
    not VECTOR_FILE.exists(), reason="real-capture vectors not present"
)


def _vectors() -> list[dict]:
    return json.loads(VECTOR_FILE.read_text())["vectors"]


def _ies(kind: str) -> list[bytes]:
    return [base64.b64decode(v["ie_b64"]) for v in _vectors() if v["kind"] == kind]


class TestRealOdidVectors:
    def test_every_vector_parses_without_error(self):
        ies = _ies("odid")
        assert ies, "no ODID vectors"
        for ie in ies:
            assert odid.parse_vendor_ie(ie) is not None

    def test_message_pack_carries_three_messages(self):
        """83-byte IE = 5 header + 3 pack header + 3x25. Basic ID, Location, System."""
        ie = _ies("odid")[0]
        assert len(ie) == 83
        payload = odid.parse_vendor_ie(ie)
        assert payload.basic_id is not None
        assert payload.location is not None
        assert payload.system is not None

    def test_serial_and_manufacturer(self):
        payload = odid.parse_vendor_ie(_ies("odid")[0])
        assert payload.basic_id.uas_id == "1581F9DEC259E0296040"
        assert payload.basic_id.id_type == "serial_ansi_cta_2063"
        assert payload.basic_id.ua_type == "multirotor"
        assert payload.basic_id.manufacturer_code == "1581"
        assert payload.basic_id.vendor == "dji"

    def test_protocol_version_2(self):
        assert odid.parse_vendor_ie(_ies("odid")[0]).protocol_version == 2

    def test_position_is_plausible(self):
        """Guards the radian/degree class of bug: a wrong scale lands in the sea."""
        payload = odid.parse_vendor_ie(_ies("odid")[0])
        loc = payload.location
        assert loc.lat is not None and loc.lon is not None
        assert 45.0 < loc.lat < 47.0
        assert -124.0 < loc.lon < -121.0

    def test_absent_fields_stay_none(self):
        """The real aircraft omits pressure altitude and direction entirely."""
        loc = odid.parse_vendor_ie(_ies("odid")[0]).location
        assert loc.alt_pressure_m is None
        assert loc.track_deg is None

    def test_system_message_always_present(self):
        for ie in _ies("odid"):
            assert odid.parse_vendor_ie(ie).system is not None

    def test_operator_location_appears_only_after_a_fix(self):
        """Not every beacon carries an operator position.

        The earliest beacons in the capture decode to operator_lat=None: the
        controller had no GPS fix yet, so the System message carries the 0,0
        sentinel. Later beacons have a real position.

        This is why the UI must treat a missing operator position as normal
        rather than exceptional -- it is not merely the redaction flag, it is
        the aircraft's own startup behaviour.
        """
        systems = [odid.parse_vendor_ie(ie).system for ie in _ies("odid")]
        assert any(s.operator_lat is None for s in systems), "expected some pre-fix beacons"
        assert any(s.operator_lat is not None for s in systems), "expected some fixed beacons"

        for s in systems:
            if s.operator_lat is not None:
                assert 45.0 < s.operator_lat < 47.0
                assert -124.0 < s.operator_lon < -121.0

    def test_no_proprietary_dji_ie(self):
        """The Mini 5 Pro uses OcuSync, so its DroneID never rides on Wi-Fi.

        Confirms the Class B prediction in docs/ops/04-calibration.md. If this
        ever fails, a DJI Wi-Fi-mode aircraft appeared and the dji.py SCALES
        constants finally have something to calibrate against.
        """
        assert _ies("dji") == []


class TestRealSsidPattern:
    def test_ssid_embeds_the_serial(self):
        """Observed: SSID is literally 'RID-<serial>'.

        A vendor fingerprint that needs no OUI and no payload parsing.
        """
        vectors = _vectors()
        ssid = vectors[0]["ssid"]
        assert ssid.startswith("RID-")
        assert ssid[4:] == "1581F9DEC259E0296040"

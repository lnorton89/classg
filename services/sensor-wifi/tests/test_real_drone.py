"""Regression tests built from a REAL aircraft's Remote ID broadcast.

Ground truth captured 2026-08-10 with the OpenDroneID receiver app on Android,
DJI drone at ~10 m, RSSI -35 dBm, transport = Wi-Fi Beacon, protocol version 2.

The serial and coordinates from that observation are deliberately NOT reproduced
here - they identify a specific aircraft and its operator's position. What is
encoded instead is the *structure* the real drone exhibited, which is what the
parser has to handle correctly:

  - Basic ID present with a CTA-2063-A serial; a second Basic ID slot exists
  - Pressure altitude ABSENT (invalid sentinel) while geodetic altitude present
  - Direction ABSENT (invalid sentinel) while speeds are present and zero
  - Height measured over Takeoff, not AGL
  - Status = Airborne
  - System message present, carrying operator location
  - Operator ID, Self ID, and Authentication all empty

Several of these are exactly the "field is absent" cases that a parser gets
wrong by inventing a plausible number instead of None.
"""

from __future__ import annotations

import struct

import pytest

from classg_wifi.parsers import odid


def _msg(msg_type: int, payload: bytes, version: int = 2) -> bytes:
    assert len(payload) == 24
    return bytes([(msg_type << 4) | version]) + payload


def _pack(*messages: bytes) -> bytes:
    return bytes([(0xF << 4) | 2]) + bytes([25, len(messages)]) + b"".join(messages)


def _basic_id(uas_id: str, id_type: int = 1, ua_type: int = 2) -> bytes:
    return _msg(0x0, bytes([(id_type << 4) | ua_type])
                + uas_id.encode().ljust(20, b"\x00")[:20] + b"\x00" * 3)


def _location_as_observed() -> bytes:
    """Mirrors the real aircraft: airborne, stationary, no baro, no direction."""
    p = bytearray(24)
    p[0] = (2 << 4)                       # status airborne, height over takeoff
    p[1] = 200                            # direction: invalid (>179)
    p[2] = 0                              # horizontal speed 0.00 m/s
    p[3] = 0                              # vertical speed 0.00 m/s
    struct.pack_into("<ii", p, 4, int(46.0399513 * 1e7), int(-122.7673339 * 1e7))
    # pressure altitude = 0 -> the "not available" sentinel, as the app showed
    struct.pack_into("<H", p, 12, 0)
    struct.pack_into("<H", p, 14, 2026)   # geodetic 13.0 m -> (13+1000)/0.5
    struct.pack_into("<H", p, 16, 2002)   # height 1.0 m
    p[18] = (2 << 4) | 12                 # vert acc <45 m, horiz acc <1 m
    p[19] = 4                             # speed acc <0.3 m/s, baro acc 0 (none)
    struct.pack_into("<H", p, 20, 2960)   # timestamp 04:56 into the hour
    return _msg(0x1, bytes(p))


class TestRealDroneStructure:
    def test_absent_fields_decode_to_none_not_a_number(self):
        """The failure mode this guards: inventing -1000 m or a 200 deg heading."""
        loc = odid.parse_message_pack(_pack(_location_as_observed())).location
        assert loc is not None
        assert loc.alt_pressure_m is None, "pressure altitude was not broadcast"
        assert loc.track_deg is None, "direction was not broadcast"
        assert loc.alt_geodetic_m == pytest.approx(13.0)
        assert loc.height_m == pytest.approx(1.0)
        assert loc.height_is_agl is False, "app reported 'Height Over: Takeoff'"
        assert loc.status == "airborne"

    def test_zero_speed_is_zero_not_missing(self):
        """0.00 m/s is a real measurement; only 255 means unavailable."""
        loc = odid.parse_message_pack(_pack(_location_as_observed())).location
        assert loc.speed_mps == 0.0
        assert loc.vertical_speed_mps == 0.0

    def test_accuracy_enums_match_the_app(self):
        loc = odid.parse_message_pack(_pack(_location_as_observed())).location
        assert loc.h_accuracy_m == 1.0    # app: "< 1 m"
        assert loc.v_accuracy_m == 45.0   # app: "< 45 m"

    def test_timestamp_matches_displayed_minutes_seconds(self):
        loc = odid.parse_message_pack(_pack(_location_as_observed())).location
        assert loc.timestamp_s_into_hour == pytest.approx(296.0)  # 04:56


class TestCta2063Serial:
    def test_dji_manufacturer_code(self):
        """Structure of the real serial: 1581 + F (len 15) + 15 chars."""
        b = odid.parse_message_pack(_pack(_basic_id("1581F" + "0" * 15))).basic_id
        assert b is not None
        assert b.manufacturer_code == "1581"
        assert b.vendor == "dji"

    def test_length_code_must_agree_with_actual_length(self):
        # Declares 15 trailing chars but supplies 5.
        b = odid.parse_message_pack(_pack(_basic_id("1581F" + "0" * 5))).basic_id
        assert b.manufacturer_code is None

    def test_non_serial_id_type_has_no_manufacturer_code(self):
        b = odid.parse_message_pack(_pack(_basic_id("SOMEUUID", id_type=3))).basic_id
        assert b.manufacturer_code is None
        assert b.vendor is None

    def test_unknown_manufacturer_code_still_parses(self):
        b = odid.parse_message_pack(_pack(_basic_id("9999F" + "0" * 15))).basic_id
        assert b.manufacturer_code == "9999"
        assert b.vendor is None


class TestMultipleBasicIds:
    """F3411 allows more than one Basic ID. Last-one-wins loses the serial."""

    def test_empty_second_basic_id_does_not_erase_the_serial(self):
        serial = "1581F" + "0" * 15
        payload = odid.parse_message_pack(_pack(
            _basic_id(serial),
            _basic_id("", id_type=0, ua_type=0),   # the "Basic ID 2" empty slot
        ))
        assert len(payload.basic_ids) == 2
        assert payload.basic_id is not None
        assert payload.basic_id.uas_id == serial
        assert payload.basic_id.vendor == "dji"

    def test_serial_preferred_over_session_id_regardless_of_order(self):
        serial = "1581F" + "0" * 15
        for messages in (
            (_basic_id("SESSION123", id_type=4), _basic_id(serial)),
            (_basic_id(serial), _basic_id("SESSION123", id_type=4)),
        ):
            payload = odid.parse_message_pack(_pack(*messages))
            assert payload.basic_id.uas_id == serial

    def test_single_basic_id_unchanged(self):
        payload = odid.parse_message_pack(_pack(_basic_id("1581F" + "0" * 15)))
        assert len(payload.basic_ids) == 1
        assert payload.basic_id is not None


class TestObservedMessageSet:
    """The real drone sent Basic ID + Location + System; others were empty."""

    def test_full_pack_decodes(self):
        system = bytearray(24)
        system[0] = (1 << 3)  # operator location type: dynamic
        struct.pack_into("<ii", system, 1,
                         int(46.0400589 * 1e7), int(-122.7669513 * 1e7))
        struct.pack_into("<H", system, 9, 1)      # area count
        struct.pack_into("<H", system, 17, 2087)  # operator altitude 43.5 m

        payload = odid.parse_message_pack(_pack(
            _basic_id("1581F" + "0" * 15),
            _location_as_observed(),
            _msg(0x4, bytes(system)),
        ))

        assert payload.basic_id is not None
        assert payload.location is not None
        assert payload.system is not None
        assert payload.operator_id is None, "operator ID was empty on the real drone"
        assert payload.self_id is None

        # Operator location is the sensitive field; confirm it survives decoding
        # so retention handling actually has something to protect.
        assert payload.system.operator_lat == pytest.approx(46.0400589, abs=1e-6)
        assert payload.system.operator_alt_m == pytest.approx(43.5)

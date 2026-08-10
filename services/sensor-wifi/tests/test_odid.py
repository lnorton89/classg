"""Open Drone ID parser tests.

Parser bugs in this project are SILENT - they produce plausible wrong positions
rather than crashes. That makes these tests the highest-value tests in the repo.

Boundary cases here mirror docs/planning/test-plan.md#layer-1. Once real captures
exist in tests/vectors/, add corpus replay assertions alongside these.
"""

from __future__ import annotations

import struct

import pytest
from hypothesis import given
from hypothesis import strategies as st

from classg_wifi.parsers import odid


def _message(msg_type: int, payload: bytes, version: int = 2) -> bytes:
    assert len(payload) == 24
    return bytes([(msg_type << 4) | version]) + payload


def _pack(*messages: bytes) -> bytes:
    return (
        bytes([(odid.MessageType.MESSAGE_PACK << 4) | 2])
        + bytes([odid.MESSAGE_SIZE, len(messages)])
        + b"".join(messages)
    )


def _basic_id(serial: str = "1596F3B24C5D7E8F9A0B") -> bytes:
    # high nibble = ID type (1 = serial), low nibble = UA type (2 = multirotor)
    return _message(0x0, bytes([0x12]) + serial.encode().ljust(20, b"\x00") + b"\x00" * 3)


def _location(lat: float = 47.3769, lon: float = 8.5417) -> bytes:
    payload = bytearray(24)
    payload[0] = (2 << 4) | 0b000        # status=airborne, no flags
    payload[1] = 90                       # track 90 deg
    payload[2] = 40                       # speed: 40 * 0.25 = 10 m/s
    payload[3] = struct.pack("<b", 4)[0]  # vertical speed: 4 * 0.5 = 2 m/s
    struct.pack_into("<ii", payload, 4, int(lat * 1e7), int(lon * 1e7))
    struct.pack_into("<HHH", payload, 12, 3020, 3020, 2200)  # alt/alt/height
    payload[18] = (5 << 4) | 11           # v_acc=3.0 m, h_acc=3.0 m
    struct.pack_into("<H", payload, 20, 12345)
    return _message(0x1, bytes(payload))


class TestBasicId:
    def test_serial_and_types(self):
        payload = odid.parse_message_pack(_pack(_basic_id()))
        assert payload.basic_id is not None
        assert payload.basic_id.uas_id == "1596F3B24C5D7E8F9A0B"
        assert payload.basic_id.id_type == "serial_ansi_cta_2063"
        assert payload.basic_id.ua_type == "multirotor"

    def test_null_padded_serial_is_trimmed(self):
        payload = odid.parse_message_pack(_pack(_basic_id("SHORT")))
        assert payload.basic_id.uas_id == "SHORT"


class TestLocation:
    def test_position_and_kinematics(self):
        payload = odid.parse_message_pack(_pack(_location()))
        loc = payload.location
        assert loc is not None
        assert loc.lat == pytest.approx(47.3769, abs=1e-6)
        assert loc.lon == pytest.approx(8.5417, abs=1e-6)
        assert loc.status == "airborne"
        assert loc.track_deg == 90.0
        assert loc.speed_mps == pytest.approx(10.0)
        assert loc.vertical_speed_mps == pytest.approx(2.0)
        assert loc.alt_geodetic_m == pytest.approx(510.0)   # 3020*0.5 - 1000
        assert loc.timestamp_s_into_hour == pytest.approx(1234.5)

    def test_zero_latlon_is_no_fix_not_gulf_of_guinea(self):
        payload = odid.parse_message_pack(_pack(_location(lat=0.0, lon=0.0)))
        assert payload.location.lat is None
        assert payload.location.lon is None

    def test_speed_multiplier_high_range(self):
        payload = bytearray(_location()[1:])
        payload[0] |= 0b1          # speed multiplier set
        payload[2] = 100
        msg = _message(0x1, bytes(payload))
        loc = odid.parse_message_pack(_pack(msg)).location
        assert loc.speed_mps == pytest.approx(100 * 0.75 + 63.75)

    def test_invalid_speed_sentinel(self):
        payload = bytearray(_location()[1:])
        payload[2] = odid.INVALID_SPEED_H
        loc = odid.parse_message_pack(_pack(_message(0x1, bytes(payload)))).location
        assert loc.speed_mps is None

    def test_east_west_direction_segment(self):
        payload = bytearray(_location()[1:])
        payload[0] |= 0b10         # E/W segment set
        payload[1] = 45
        loc = odid.parse_message_pack(_pack(_message(0x1, bytes(payload)))).location
        assert loc.track_deg == 225.0

    def test_negative_vertical_speed(self):
        payload = bytearray(_location()[1:])
        payload[3] = struct.pack("<b", -10)[0]
        loc = odid.parse_message_pack(_pack(_message(0x1, bytes(payload)))).location
        assert loc.vertical_speed_mps == pytest.approx(-5.0)

    def test_zero_altitude_is_invalid_sentinel(self):
        payload = bytearray(_location()[1:])
        struct.pack_into("<HHH", payload, 12, 0, 0, 0)
        loc = odid.parse_message_pack(_pack(_message(0x1, bytes(payload)))).location
        assert loc.alt_geodetic_m is None
        assert loc.alt_pressure_m is None


class TestMessagePack:
    def test_multiple_messages(self):
        payload = odid.parse_message_pack(_pack(_basic_id(), _location()))
        assert payload.basic_id is not None
        assert payload.location is not None

    def test_bare_message_without_pack(self):
        payload = odid.parse_message_pack(_basic_id())
        assert payload.basic_id is not None

    def test_pack_claiming_more_messages_than_present(self):
        data = bytearray(_pack(_basic_id()))
        data[2] = 5   # claim 5 messages, only 1 present
        with pytest.raises(odid.OdidParseError, match="only"):
            odid.parse_message_pack(bytes(data))

    def test_implausible_message_count(self):
        data = bytearray(_pack(_basic_id()))
        data[2] = 200
        with pytest.raises(odid.OdidParseError, match="implausible"):
            odid.parse_message_pack(bytes(data))

    def test_unknown_message_type_is_skipped_not_fatal(self):
        payload = odid.parse_message_pack(_pack(_basic_id(), _message(0xE, b"\x00" * 24)))
        assert payload.basic_id is not None
        assert 0xE in payload.unknown_types

    def test_unsupported_version_rejected_loudly(self):
        with pytest.raises(odid.OdidParseError, match="version"):
            odid.parse_message_pack(_message(0x0, b"\x00" * 24, version=9))


class TestVendorIe:
    def test_non_odid_ie_returns_none(self):
        assert odid.parse_vendor_ie(b"\x26\x37\x12\x00\x10" + b"\x00" * 20) is None

    def test_odid_ie(self):
        ie = odid.ODID_OUI + bytes([odid.ODID_VENDOR_TYPE, 0x42]) + _pack(_basic_id())
        payload = odid.parse_vendor_ie(ie)
        assert payload is not None
        assert payload.basic_id.uas_id == "1596F3B24C5D7E8F9A0B"

    def test_short_ie_returns_none(self):
        assert odid.parse_vendor_ie(b"\xfa\x0b") is None


class TestRobustness:
    """A drone detector that crashes on a malformed beacon is a DoS target."""

    @given(st.binary(min_size=0, max_size=300))
    def test_never_crashes_on_arbitrary_input(self, data: bytes):
        try:
            odid.parse_message_pack(data)
        except odid.OdidParseError:
            pass
        except Exception as exc:  # noqa: BLE001
            pytest.fail(f"unexpected {type(exc).__name__}: {exc}")

    @given(st.binary(min_size=0, max_size=300))
    def test_vendor_ie_never_crashes(self, data: bytes):
        try:
            odid.parse_vendor_ie(data)
        except odid.OdidParseError:
            pass
        except Exception as exc:  # noqa: BLE001
            pytest.fail(f"unexpected {type(exc).__name__}: {exc}")

    def test_truncated_message(self):
        with pytest.raises(odid.OdidParseError):
            odid.parse_message(b"\x02\x00\x00", odid.OdidPayload(protocol_version=2))

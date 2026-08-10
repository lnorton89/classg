"""802.11 / radiotap dissection tests.

This layer sits between the adapter and every parser. If it is wrong, a real
capture produces nothing and the failure looks like a parser bug. Proving it
against synthetic frames costs nothing and saves a wasted flight.
"""

from __future__ import annotations

import struct

import pytest
from hypothesis import given
from hypothesis import strategies as st

from classg_wifi.parsers import dji, odid
from classg_wifi.parsers.dot11 import Dot11ParseError, parse_beacon, parse_radiotap
from tests.synthetic import beacon_frame, radiotap, tag


class TestRadiotap:
    def test_extracts_frequency_and_rssi(self):
        info = parse_radiotap(radiotap(freq_mhz=2437, rssi_dbm=-62))
        assert info.freq_mhz == 2437
        assert info.rssi_dbm == -62

    def test_five_ghz(self):
        info = parse_radiotap(radiotap(freq_mhz=5180, rssi_dbm=-70))
        assert info.freq_mhz == 5180

    def test_rejects_implausible_length(self):
        bad = struct.pack("<BBHI", 0, 0, 9999, 0)
        with pytest.raises(Dot11ParseError, match="implausible"):
            parse_radiotap(bad)

    def test_rejects_short_header(self):
        with pytest.raises(Dot11ParseError):
            parse_radiotap(b"\x00\x00")


class TestBeacon:
    def test_parses_transmitter_and_ssid(self):
        frame = beacon_frame(transmitter="60:60:1f:aa:bb:cc", ssid="Mavic-A1B2C3")
        beacon = parse_beacon(frame)
        assert beacon is not None
        assert beacon.transmitter == "60:60:1f:aa:bb:cc"
        assert beacon.ssid == "Mavic-A1B2C3"
        assert beacon.freq_mhz == 2437

    def test_non_beacon_returns_none(self):
        frame = bytearray(beacon_frame())
        rt_len = frame[2]
        frame[rt_len] = 0x40  # probe request, not a beacon
        assert parse_beacon(bytes(frame)) is None

    def test_vendor_ies_are_extracted(self):
        ies = [b"\x00\x11\x22payload", b"\xaa\xbb\xccother"]
        beacon = parse_beacon(beacon_frame(vendor_ies=ies))
        assert beacon is not None
        assert beacon.vendor_ies() == ies

    def test_truncated_trailing_tag_does_not_lose_earlier_ones(self):
        """A good DroneID IE followed by a mangled tail must still decode."""
        good = b"\x00\x11\x22good"
        frame = beacon_frame(vendor_ies=[good]) + bytes([221, 200, 0x01, 0x02])
        beacon = parse_beacon(frame)
        assert beacon is not None
        assert good in beacon.vendor_ies()


class TestEndToEnd:
    """The full chain a real capture exercises: frame -> IE -> decoded payload."""

    def test_odid_beacon_round_trip(self):
        serial = b"1596F3B24C5D7E8F9A0B".ljust(20, b"\x00")
        basic = bytes([0x02, 0x12]) + serial + b"\x00" * 3
        pack = bytes([(0xF << 4) | 2]) + bytes([25, 1]) + basic
        ie = odid.ODID_OUI + bytes([odid.ODID_VENDOR_TYPE, 0x00]) + pack

        beacon = parse_beacon(beacon_frame(vendor_ies=[ie]))
        assert beacon is not None
        payload = odid.parse_vendor_ie(beacon.vendor_ies()[0])
        assert payload is not None
        assert payload.basic_id is not None
        assert payload.basic_id.uas_id == "1596F3B24C5D7E8F9A0B"

    def test_dji_beacon_round_trip(self):
        lat_deg, lon_deg = 47.3769, 8.5417
        raw_lat = int(lat_deg * dji.RAD_SCALE)
        raw_lon = int(lon_deg * dji.RAD_SCALE)

        payload = bytearray()
        payload += bytes([0x02])                      # version
        payload += struct.pack("<H", 1234)            # sequence
        payload += struct.pack("<H", 0x000F)          # state info
        payload += b"1581F5FMD234A00A1234".ljust(16, b"\x00")[:16]
        payload += struct.pack("<i", raw_lon)
        payload += struct.pack("<i", raw_lat)
        payload += struct.pack("<h", 120)             # altitude
        payload += struct.pack("<h", 100)             # height
        payload += struct.pack("<hhh", 50, -20, 5)    # v_north, v_east, v_up
        payload += struct.pack("<hhh", 0, 0, 900)     # pitch, roll, yaw
        payload += struct.pack("<i", raw_lat)         # operator lat
        payload += struct.pack("<i", raw_lon)         # operator lon
        payload += struct.pack("<i", raw_lon)         # home lon
        payload += struct.pack("<i", raw_lat)         # home lat
        payload += bytes([0x1A])                      # product type
        payload += bytes([0x00])                      # uuid len

        ie = dji.DJI_OUI + bytes([0x00, dji.SUBCMD_TELEMETRY]) + bytes(payload)

        beacon = parse_beacon(beacon_frame(vendor_ies=[ie]))
        assert beacon is not None
        tel = dji.parse_vendor_ie(beacon.vendor_ies()[0])
        assert isinstance(tel, dji.DjiTelemetry)

        assert tel.serial == "1581F5FMD234A00A1234"[:16].rstrip("\x00")
        # The radian conversion is the one DJI field that is unambiguous, so it
        # is asserted precisely. Everything else needs real-drone calibration.
        assert tel.lat == pytest.approx(lat_deg, abs=1e-4)
        assert tel.lon == pytest.approx(lon_deg, abs=1e-4)
        assert tel.gps_valid and tel.in_air

        # Raw values must survive for docs/ops/04-calibration.md.
        assert tel.raw["height"] == 100
        assert tel.raw["altitude"] == 120

    def test_dji_zero_position_is_no_fix(self):
        payload = bytearray(bytes([0x02]) + struct.pack("<HH", 1, 0))
        payload += b"SERIAL0000000000"
        payload += struct.pack("<ii", 0, 0)  # lon, lat = no GPS fix
        payload += bytes(40)
        ie = dji.DJI_OUI + bytes([0x00, dji.SUBCMD_TELEMETRY]) + bytes(payload)
        tel = dji.parse_vendor_ie(ie)
        assert isinstance(tel, dji.DjiTelemetry)
        assert tel.lat is None and tel.lon is None


class TestRobustness:
    @given(st.binary(min_size=0, max_size=200))
    def test_parse_beacon_never_crashes(self, data: bytes):
        try:
            parse_beacon(data)
        except Dot11ParseError:
            pass
        except Exception as exc:
            pytest.fail(f"unexpected {type(exc).__name__}: {exc}")

    def test_tag_length_beyond_frame_is_ignored(self):
        frame = beacon_frame() + tag(221, b"x" * 10)[:-5]
        assert parse_beacon(frame) is not None

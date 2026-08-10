"""End-to-end test of the Milestone 0 analysis tool.

Builds a synthetic capture that looks like a DJI hovering: ~1 Hz beacons on
channel 6 carrying both a DJI DroneID IE and an ASTM F3411 IE, mixed in with a
neighbour's access point. Asserts the report answers the three questions
Milestone 0 exists to answer -- channel, beacon interval, and raw field values.
"""

from __future__ import annotations

import struct

import pytest

from classg_wifi.analyze import analyze_pcap, render_report, summarize_channels
from classg_wifi.parsers import dji, odid
from tests.synthetic import beacon_frame, write_pcap

pytest.importorskip("scapy", reason="analyze requires the 'replay' extra")

DRONE_MAC = "60:60:1f:aa:bb:cc"
NEIGHBOUR_MAC = "aa:bb:cc:11:22:33"


def _odid_ie() -> bytes:
    basic = bytes([0x02, 0x12]) + b"1596F3B24C5D7E8F9A0B".ljust(20, b"\x00") + b"\x00" * 3

    loc = bytearray(24)
    loc[0] = (2 << 4)                      # airborne
    loc[1] = 90                            # track
    loc[2] = 40                            # speed -> 10 m/s
    loc[3] = struct.pack("<b", 4)[0]       # vertical speed -> 2 m/s
    struct.pack_into("<ii", loc, 4, int(47.3769 * 1e7), int(8.5417 * 1e7))
    struct.pack_into("<HHH", loc, 12, 3020, 3020, 2200)
    loc[18] = (5 << 4) | 11
    struct.pack_into("<H", loc, 20, 12345)
    location = bytes([(1 << 4) | 2]) + bytes(loc)

    pack = bytes([(0xF << 4) | 2]) + bytes([25, 2]) + basic + location
    return odid.ODID_OUI + bytes([odid.ODID_VENDOR_TYPE, 0x00]) + pack


def _dji_ie() -> bytes:
    raw_lat = int(47.3769 * dji.RAD_SCALE)
    raw_lon = int(8.5417 * dji.RAD_SCALE)

    p = bytearray()
    p += bytes([0x02])
    p += struct.pack("<HH", 42, 0x000F)
    p += b"1581F5FMD234A00A".ljust(16, b"\x00")
    p += struct.pack("<ii", raw_lon, raw_lat)
    p += struct.pack("<hh", 120, 100)          # altitude, height
    p += struct.pack("<hhh", 50, -20, 5)       # velocities
    p += struct.pack("<hhh", 0, 0, 900)        # attitude
    p += struct.pack("<ii", raw_lat, raw_lon)  # operator
    p += struct.pack("<ii", raw_lon, raw_lat)  # home
    p += bytes([0x1A, 0x00])
    return dji.DJI_OUI + bytes([0x00, dji.SUBCMD_TELEMETRY]) + bytes(p)


@pytest.fixture
def capture(tmp_path) -> str:
    frames: list[tuple[float, bytes]] = []
    base = 1_760_000_000.0
    for i in range(30):
        frames.append((
            base + i * 1.0,  # 1 Hz, the design assumption
            beacon_frame(
                transmitter=DRONE_MAC, ssid="Mavic-A1B2C3",
                vendor_ies=[_odid_ie(), _dji_ie()],
                freq_mhz=2437, rssi_dbm=-62 - (i % 5),
            ),
        ))
    # A neighbour's AP beaconing faster, to prove it does not pollute the
    # drone's interval statistic.
    for i in range(100):
        frames.append((
            base + i * 0.1,
            beacon_frame(transmitter=NEIGHBOUR_MAC, ssid="HomeWiFi",
                         vendor_ies=[], freq_mhz=2437),
        ))

    path = tmp_path / "synthetic.pcap"
    write_pcap(str(path), sorted(frames, key=lambda f: f[0]))
    return str(path)


def test_identifies_only_the_drone(capture: str):
    result = analyze_pcap(capture)
    assert result.beacons == 130
    assert len(result.transmitters) == 2

    drones = result.drones
    assert len(drones) == 1, "neighbour AP must not be classified as a drone"
    assert drones[0].mac == DRONE_MAC
    assert drones[0].odid_count == 30
    assert drones[0].dji_count == 30
    assert result.parse_errors == 0


def test_beacon_interval_excludes_non_drone_traffic(capture: str):
    """The neighbour beacons at 10 Hz; the measured interval must stay ~1 Hz."""
    drone = analyze_pcap(capture).drones[0]
    intervals = drone.intervals_ms()
    assert intervals
    median = sorted(intervals)[len(intervals) // 2]
    assert 900 <= median <= 1100, f"expected ~1000 ms, got {median}"


def test_channel_attribution(capture: str):
    result = analyze_pcap(capture)
    assert result.drones[0].channels == {6}
    assert set(summarize_channels(result)) == {6}


def test_report_surfaces_calibration_and_operator_location(capture: str):
    report = render_report(analyze_pcap(capture))

    assert "1596F3B24C5D7E8F9A0B" in report      # ODID serial
    assert "1581F5FMD234A00A" in report          # DJI serial
    assert "CALIBRATION" in report
    assert "OPERATOR LOCATION" in report         # must be flagged as sensitive

    # Raw values are the whole point of the calibration block.
    assert "100" in report and "120" in report


def test_empty_capture_explains_what_to_check(tmp_path):
    path = tmp_path / "empty.pcap"
    write_pcap(str(path), [(1.0, beacon_frame(transmitter=NEIGHBOUR_MAC,
                                              ssid="HomeWiFi", vendor_ies=[]))])
    report = render_report(analyze_pcap(str(path)))
    assert "NO DRONE BEACONS FOUND" in report
    assert "sweep" in report

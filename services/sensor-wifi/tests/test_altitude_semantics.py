"""What `height_agl_m` is allowed to mean.

`height_agl_m` is height above the ground under the aircraft -- see
schemas/track.schema.json, which goes as far as defining `terrain_elevation_m`
purely so a consumer can tell a derived height from a broadcast one. Both
Remote ID and DJI DroneID also broadcast a height measured from the TAKEOFF
point, and the two are the same number only while the drone is over its own
launch pad.

The Class A path has always gated on the ODID height-type flag. The Class B
path did not: it published DJI's takeoff-referenced height as `height_agl_m`
outright, so one aircraft broadcasting both beacons contradicted itself
depending on which was decoded. `docs/ops/04-calibration.md` records the Mini 5
Pro doing exactly that.

Field note behind these, from the unit's own database: across 2,430 real Class A
detections the aircraft set the AGL flag only while grounded and reporting 0 m,
and reported "over takeoff" for every airborne fix. A broadcast AGL is the rare
case, not the normal one -- which is what the terrain-derive path in fusion
exists for.
"""

from __future__ import annotations

import struct
from typing import Any

from classg_wifi.parsers import dji, odid
from classg_wifi.pipeline import Pipeline

from .synthetic import beacon_frame

LAT, LON = 47.3769, 8.5417

# Height above takeoff, in ODID's raw encoding: (raw * 0.5) - 1000 metres.
RAW_GEODETIC = 2100  # 50.0 m
RAW_HEIGHT = 2060  # 30.0 m


def _odid_vendor_ie(*messages: bytes) -> bytes:
    pack = bytes([(0xF << 4) | 2, 25, len(messages)]) + b"".join(messages)
    return odid.ODID_OUI + bytes([odid.ODID_VENDOR_TYPE, 0x00]) + pack


def _odid_location(*, height_is_agl: bool) -> bytes:
    p = bytearray(24)
    # Airborne, and bit 2 of the flags byte is the height reference:
    # 0 = over takeoff, 1 = over ground.
    p[0] = (2 << 4) | (0b100 if height_is_agl else 0)
    struct.pack_into("<ii", p, 4, int(LAT * 1e7), int(LON * 1e7))
    struct.pack_into("<HHH", p, 12, 0, RAW_GEODETIC, RAW_HEIGHT)
    return bytes([(0x1 << 4) | 2]) + bytes(p)


def _dji_telemetry_ie(*, altitude_m: int, height_m: int) -> bytes:
    p = bytearray()
    p += bytes([0x02])
    p += struct.pack("<HH", 42, 0x000F)
    p += b"1581F5FMD234A00A".ljust(16, b"\x00")
    p += struct.pack("<ii", int(LON * dji.RAD_SCALE), int(LAT * dji.RAD_SCALE))
    p += struct.pack("<hh", altitude_m, height_m)
    p += struct.pack("<hhh", 50, -20, 5)
    p += struct.pack("<hhh", 0, 0, 900)
    p += struct.pack("<ii", int(LAT * dji.RAD_SCALE), int(LON * dji.RAD_SCALE))
    p += struct.pack("<ii", int(LON * dji.RAD_SCALE), int(LAT * dji.RAD_SCALE))
    p += bytes([0x1A, 0x00])
    return dji.DJI_OUI + bytes([0x00, dji.SUBCMD_TELEMETRY]) + bytes(p)


def _position(vendor_ie: bytes) -> dict[str, Any]:
    """One frame through the real pipeline; the position it published.

    One frame can yield more than one detection -- a vendor OUI match produces
    a Class C alongside the decoded beacon -- so this takes the one that
    actually carries a fix rather than assuming a count.
    """
    pipeline = Pipeline(sensor_id="wifi-0")
    detections = list(pipeline.process_frame(beacon_frame(vendor_ies=[vendor_ie])))
    positions = [d["position"] for d in detections if d.get("position")]
    assert len(positions) == 1, (
        f"expected one positioned detection, got {len(positions)} "
        f"from {[d['detection_class'] for d in detections]}"
    )
    return positions[0]


def test_odid_height_over_takeoff_is_not_published_as_agl() -> None:
    position = _position(_odid_vendor_ie(_odid_location(height_is_agl=False)))

    assert position["alt_geodetic_m"] == 50.0
    # The 30 m is real and it is not AGL. Dropped rather than mislabelled:
    # the schema has no field for a takeoff-referenced height.
    assert position.get("height_agl_m") is None


def test_odid_height_over_ground_is_published() -> None:
    position = _position(_odid_vendor_ie(_odid_location(height_is_agl=True)))

    assert position["alt_geodetic_m"] == 50.0
    assert position["height_agl_m"] == 30.0


def test_dji_height_is_never_published_as_agl() -> None:
    """The Class B regression.

    DJI DroneID's height is measured from the takeoff point and has no flag
    saying otherwise, so there is no case in which it is an AGL.
    """
    position = _position(_dji_telemetry_ie(altitude_m=120, height_m=100))

    assert position["alt_geodetic_m"] == 120.0
    assert position.get("height_agl_m") is None


def test_the_two_beacons_of_one_aircraft_agree_about_agl() -> None:
    """Neither path may claim an AGL the aircraft did not report.

    A DJI broadcasts both IEs. While this disagreed, the same flight showed a
    height on the map or not depending on which beacon fusion happened to fold
    in last.
    """
    odid_position = _position(_odid_vendor_ie(_odid_location(height_is_agl=False)))
    dji_position = _position(_dji_telemetry_ie(altitude_m=120, height_m=100))

    assert odid_position.get("height_agl_m") is None
    assert dji_position.get("height_agl_m") is None

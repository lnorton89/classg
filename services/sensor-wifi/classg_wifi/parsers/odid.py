"""ASTM F3411 / ASD-STAN prEN 4709-002 Open Drone ID parser.

Pure functions: bytes in, dataclasses out. No I/O, no logging side effects.

Normative reference: https://github.com/opendroneid/opendroneid-core-c
Where this disagrees with that library, the library is right. Every field here should
be validated against the capture corpus in tests/vectors/ before being trusted.

Layout notes for the reader coming from opendroneid-core-c: that library uses C
bitfields, which gcc packs LSB-first on little-endian. So `uint8_t a:4; uint8_t b:4;`
puts `a` in the LOW nibble and `b` in the HIGH nibble. Several fields below look
reversed if you forget this.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ODID_OUI = b"\xfa\x0b\xbc"
ODID_VENDOR_TYPE = 0x0D
MESSAGE_SIZE = 25
MAX_PACK_MESSAGES = 10
SUPPORTED_VERSIONS = (0, 1, 2)

# Sentinel values that mean "not available", per the standard.
INVALID_SPEED_H = 255
INVALID_SPEED_V = 63
# Valid encoded headings are 0-179; the E/W segment bit adds 180. The
# standard's explicit "unknown" sentinel is 181, but the cutoff must be 180: a
# raw 180 with the E/W bit set would decode to exactly 360.0, which the schema
# excludes (track_deg is [0, 360)).
INVALID_DIRECTION = 180
INVALID_TIMESTAMP = 0xFFFF
ALTITUDE_OFFSET_M = -1000.0


class OdidParseError(ValueError):
    """Malformed Open Drone ID data.

    Always raised rather than returning partial garbage. Callers must catch this:
    a drone detector that dies on a malformed beacon is a denial-of-service target.
    """


class MessageType(IntEnum):
    BASIC_ID = 0x0
    LOCATION = 0x1
    AUTH = 0x2
    SELF_ID = 0x3
    SYSTEM = 0x4
    OPERATOR_ID = 0x5
    MESSAGE_PACK = 0xF


ID_TYPES = {
    0: "none",
    1: "serial_ansi_cta_2063",
    2: "caa_registration",
    3: "utm_uuid",
    4: "specific_session",
}

UA_TYPES = {
    0: "undeclared", 1: "aeroplane", 2: "multirotor", 3: "gyroplane",
    4: "hybrid_vtol", 5: "ornithopter", 6: "glider", 7: "kite",
    8: "free_balloon", 9: "captive_balloon", 10: "airship",
    11: "parachute", 12: "rocket", 13: "tethered_powered", 14: "ground_obstacle",
}

OPERATIONAL_STATUS = {
    0: "undeclared", 1: "ground", 2: "airborne", 3: "emergency", 4: "rid_system_failure",
}


# ---------------------------------------------------------------------------
# Message dataclasses
# ---------------------------------------------------------------------------

# ANSI/CTA-2063-A manufacturer codes: the first 4 characters of a serial-number
# UAS ID. Confirmed against a real aircraft: DJI = 1581.
#
# This is a BETTER vendor fingerprint than a MAC OUI, because it comes from the
# Remote ID payload itself and is therefore immune to MAC randomisation. Extend
# as codes are confirmed - do not guess.
CTA2063_MANUFACTURERS = {
    "1581": "dji",
}


@dataclass(slots=True)
class BasicId:
    id_type: str
    ua_type: str
    uas_id: str | None

    @property
    def manufacturer_code(self) -> str | None:
        """CTA-2063-A manufacturer code, or None if the ID is not a valid serial.

        Format: 4-char manufacturer code, 1-char hex length code (1-F), then that
        many characters of manufacturer serial.
        """
        if self.id_type != "serial_ansi_cta_2063" or not self.uas_id:
            return None
        uid = self.uas_id
        if len(uid) < 6:
            return None
        try:
            declared = int(uid[4], 16)
        except ValueError:
            return None
        if declared == 0 or len(uid) != 5 + declared:
            return None
        return uid[:4]

    @property
    def vendor(self) -> str | None:
        code = self.manufacturer_code
        return CTA2063_MANUFACTURERS.get(code) if code else None


@dataclass(slots=True)
class Location:
    status: str
    lat: float | None
    lon: float | None
    alt_pressure_m: float | None
    alt_geodetic_m: float | None
    height_m: float | None
    height_is_agl: bool
    speed_mps: float | None
    track_deg: float | None
    vertical_speed_mps: float | None
    h_accuracy_m: float | None
    v_accuracy_m: float | None
    timestamp_s_into_hour: float | None


@dataclass(slots=True)
class SelfId:
    description_type: int
    description: str | None


@dataclass(slots=True)
class SystemMsg:
    operator_lat: float | None
    operator_lon: float | None
    operator_alt_m: float | None
    operator_location_type: int
    classification_type: int
    category_eu: int
    class_eu: int
    area_count: int
    area_radius_m: int
    timestamp: int


@dataclass(slots=True)
class OperatorId:
    operator_id_type: int
    operator_id: str | None


@dataclass(slots=True)
class OdidPayload:
    """Everything decoded from one beacon's vendor IE."""
    protocol_version: int
    # F3411 permits more than one Basic ID per pack - typically a serial number
    # plus a session ID or registration. They are collected rather than
    # overwritten; see the `basic_id` property.
    basic_ids: list[BasicId] = field(default_factory=list)
    location: Location | None = None
    self_id: SelfId | None = None
    system: SystemMsg | None = None
    operator_id: OperatorId | None = None
    unknown_types: list[int] = field(default_factory=list)

    @property
    def basic_id(self) -> BasicId | None:
        """The most useful Basic ID present.

        A naive last-one-wins would let an empty or session-ID Basic ID erase a
        perfectly good serial number, silently losing the aircraft's identity.
        Preference: populated serial number > any populated ID > anything.
        """
        if not self.basic_ids:
            return None
        for b in self.basic_ids:
            if b.uas_id and b.id_type == "serial_ansi_cta_2063":
                return b
        for b in self.basic_ids:
            if b.uas_id and b.id_type != "none":
                return b
        return self.basic_ids[0]


# ---------------------------------------------------------------------------
# Accuracy enum decoding (shared by several fields)
# ---------------------------------------------------------------------------

_H_ACCURACY_M = {
    0: None, 1: 18520.0, 2: 7408.0, 3: 3704.0, 4: 1852.0, 5: 926.0,
    6: 555.6, 7: 185.2, 8: 92.6, 9: 30.0, 10: 10.0, 11: 3.0, 12: 1.0,
}
_V_ACCURACY_M = {0: None, 1: 150.0, 2: 45.0, 3: 25.0, 4: 10.0, 5: 3.0, 6: 1.0}


# ---------------------------------------------------------------------------
# Field decoders
# ---------------------------------------------------------------------------

def _decode_altitude(raw: int) -> float | None:
    """uint16 -> metres. raw == 0 is the 'invalid' sentinel, not -1000 m."""
    if raw == 0:
        return None
    return raw * 0.5 + ALTITUDE_OFFSET_M


def _decode_latlon(raw_lat: int, raw_lon: int) -> tuple[float | None, float | None]:
    """int32 in 1e-7 degrees.

    Exactly (0, 0) means 'no GPS fix'. Emitting it as a position would place every
    unlocked drone in the Gulf of Guinea, so it is normalised to None here rather
    than downstream where it would already have polluted a track.
    """
    if raw_lat == 0 and raw_lon == 0:
        return None, None
    lat = raw_lat / 1e7
    lon = raw_lon / 1e7
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None, None
    return lat, lon


def _decode_speed(raw: int, multiplier_bit: int) -> float | None:
    if raw == INVALID_SPEED_H:
        return None
    if multiplier_bit == 0:
        return raw * 0.25
    return raw * 0.75 + (INVALID_SPEED_H * 0.25)


def _decode_vertical_speed(raw_signed: int) -> float | None:
    if raw_signed == INVALID_SPEED_V:
        return None
    return raw_signed * 0.5


def _decode_direction(raw: int, ew_segment: int) -> float | None:
    if raw >= INVALID_DIRECTION:
        return None
    return float(raw + 180) if ew_segment else float(raw)


def _decode_string(raw: bytes) -> str | None:
    """Fixed-width, null-padded ASCII. Tolerates non-ASCII rather than raising."""
    s = raw.split(b"\x00", 1)[0].decode("ascii", errors="replace").strip()
    return s or None


# ---------------------------------------------------------------------------
# Message parsers  (each takes exactly 24 bytes of payload)
# ---------------------------------------------------------------------------

def _parse_basic_id(p: bytes) -> BasicId:
    b0 = p[0]
    return BasicId(
        id_type=ID_TYPES.get(b0 >> 4, "unknown"),
        ua_type=UA_TYPES.get(b0 & 0x0F, "other"),
        uas_id=_decode_string(p[1:21]),
    )


def _parse_location(p: bytes) -> Location:
    b0 = p[0]
    speed_mult = b0 & 0x01
    ew_segment = (b0 >> 1) & 0x01
    height_type = (b0 >> 2) & 0x01
    status = OPERATIONAL_STATUS.get(b0 >> 4, "undeclared")

    raw_dir = p[1]
    raw_speed = p[2]
    raw_vspeed = struct.unpack_from("<b", p, 3)[0]
    raw_lat, raw_lon = struct.unpack_from("<ii", p, 4)
    alt_baro, alt_geo, height = struct.unpack_from("<HHH", p, 12)

    acc_byte = p[18]
    h_acc = _H_ACCURACY_M.get(acc_byte & 0x0F)
    v_acc = _V_ACCURACY_M.get(acc_byte >> 4)

    raw_ts = struct.unpack_from("<H", p, 20)[0]

    lat, lon = _decode_latlon(raw_lat, raw_lon)
    return Location(
        status=status,
        lat=lat,
        lon=lon,
        alt_pressure_m=_decode_altitude(alt_baro),
        alt_geodetic_m=_decode_altitude(alt_geo),
        height_m=_decode_altitude(height),
        height_is_agl=bool(height_type),
        speed_mps=_decode_speed(raw_speed, speed_mult),
        track_deg=_decode_direction(raw_dir, ew_segment),
        vertical_speed_mps=_decode_vertical_speed(raw_vspeed),
        h_accuracy_m=h_acc,
        v_accuracy_m=v_acc,
        timestamp_s_into_hour=None if raw_ts == INVALID_TIMESTAMP else raw_ts * 0.1,
    )


def _parse_self_id(p: bytes) -> SelfId:
    return SelfId(description_type=p[0], description=_decode_string(p[1:24]))


def _parse_system(p: bytes) -> SystemMsg:
    b0 = p[0]
    op_loc_type = (b0 >> 3) & 0x03
    classification_type = b0 & 0x07

    raw_lat, raw_lon = struct.unpack_from("<ii", p, 1)
    area_count, area_radius = struct.unpack_from("<HB", p, 9)
    class_byte = p[16]
    op_alt_raw = struct.unpack_from("<H", p, 17)[0]
    timestamp = struct.unpack_from("<I", p, 19)[0]

    lat, lon = _decode_latlon(raw_lat, raw_lon)
    return SystemMsg(
        operator_lat=lat,
        operator_lon=lon,
        operator_alt_m=_decode_altitude(op_alt_raw),
        operator_location_type=op_loc_type,
        classification_type=classification_type,
        category_eu=class_byte & 0x0F,
        class_eu=class_byte >> 4,
        area_count=area_count,
        area_radius_m=area_radius * 10,
        timestamp=timestamp,
    )


def _parse_operator_id(p: bytes) -> OperatorId:
    return OperatorId(operator_id_type=p[0], operator_id=_decode_string(p[1:21]))


_DISPATCH: dict[int, tuple[str, Any]] = {
    MessageType.LOCATION: ("location", _parse_location),
    MessageType.SELF_ID: ("self_id", _parse_self_id),
    MessageType.SYSTEM: ("system", _parse_system),
    MessageType.OPERATOR_ID: ("operator_id", _parse_operator_id),
}


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def parse_message(msg: bytes, payload: OdidPayload) -> None:
    """Parse one 25-byte message into `payload`. Unknown types are recorded, not fatal."""
    if len(msg) != MESSAGE_SIZE:
        raise OdidParseError(f"message must be {MESSAGE_SIZE} bytes, got {len(msg)}")

    header = msg[0]
    msg_type = header >> 4
    version = header & 0x0F

    if version not in SUPPORTED_VERSIONS:
        # Reject loudly. Silently misparsing a future version produces plausible
        # wrong positions, which is worse than no data.
        raise OdidParseError(f"unsupported ODID protocol version {version}")

    payload.protocol_version = version
    body = msg[1:]

    # Basic ID accumulates; everything else is single-valued.
    if msg_type == MessageType.BASIC_ID:
        payload.basic_ids.append(_parse_basic_id(body))
        return

    entry = _DISPATCH.get(msg_type)
    if entry is None:
        payload.unknown_types.append(msg_type)
        return

    attr, parser = entry
    setattr(payload, attr, parser(body))


def parse_message_pack(data: bytes) -> OdidPayload:
    """Parse a Message Pack (type 0xF) or a single bare message.

    Wi-Fi Beacon almost always carries a pack: Basic ID + Location + System +
    Operator ID together.
    """
    if len(data) < 1:
        raise OdidParseError("empty ODID payload")

    payload = OdidPayload(protocol_version=data[0] & 0x0F)

    if (data[0] >> 4) != MessageType.MESSAGE_PACK:
        parse_message(data[:MESSAGE_SIZE], payload)
        return payload

    if len(data) < 3:
        raise OdidParseError("truncated message pack header")

    single_size = data[1]
    count = data[2]

    if single_size != MESSAGE_SIZE:
        raise OdidParseError(f"unexpected message size {single_size} in pack")
    if not 1 <= count <= MAX_PACK_MESSAGES:
        raise OdidParseError(f"implausible message count {count} in pack")

    needed = 3 + count * MESSAGE_SIZE
    if len(data) < needed:
        raise OdidParseError(
            f"pack claims {count} messages ({needed} bytes) but only {len(data)} present"
        )

    for i in range(count):
        start = 3 + i * MESSAGE_SIZE
        parse_message(data[start:start + MESSAGE_SIZE], payload)

    return payload


def parse_vendor_ie(ie_body: bytes) -> OdidPayload | None:
    """Parse the body of an 802.11 vendor-specific IE (tag 221).

    Returns None if this is not an Open Drone ID IE. Raises OdidParseError if it
    claims to be one but is malformed.

    Layout: OUI(3) | vendor_type(1) | send_counter(1) | message pack
    """
    if len(ie_body) < 5:
        return None
    if ie_body[0:3] != ODID_OUI or ie_body[3] != ODID_VENDOR_TYPE:
        return None
    return parse_message_pack(ie_body[5:])

"""DJI Wi-Fi DroneID parser (802.11 vendor IE, OUI 26:37:12).

This is the *Wi-Fi* DroneID, not the OcuSync one. See docs/research/04-protocol-dji.md
for why they are different protocols with the same name, and why neither of the
project's radios can receive the OcuSync variant.

CALIBRATION REQUIRED. Field ORDER below is well attested across public reference
implementations (Kismet, bkerler/DroneID, Bender & Reith 2022), but DJI has shipped
firmware with differing offsets and units. The scale factors marked CALIBRATE are
hypotheses until confirmed against a real aircraft.

Resolve them with the procedure in docs/planning/test-plan.md#layer-2, record the
answers in docs/ops/04-calibration.md, then update SCALES below with a comment
naming the drone model and firmware version.

This parser is deliberately defensive: every field is bounds-checked and any field
past the end of a short payload is returned as None rather than raising, because
truncated variants are expected in the wild.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass, field

DJI_OUI = b"\x26\x37\x12"

SUBCMD_TELEMETRY = 0x10
SUBCMD_FLIGHT_PURPOSE = 0x11

# DJI encodes angles as radians * 1e7. Degrees = raw / 1e7 * (180/pi).
#   1e7 / (180/pi) == 174532.925...
# A decoded position ~57x too small means this conversion was skipped.
RAD_SCALE = 1e7 / (180.0 / math.pi)

# --- CALIBRATE: see module docstring ---------------------------------------
SCALES = {
    # Hypothesis: raw int16 is already metres. If hovering at an app-indicated
    # 10 m decodes as 100, the true unit is decimetres -> change to 0.1.
    "altitude_m": 1.0,
    "height_m": 1.0,
    # Hypothesis: raw int16 is decimetres/second.
    "velocity_mps": 0.1,
    # Hypothesis: raw int16 is deci-degrees.
    "attitude_deg": 0.1,
}
# ---------------------------------------------------------------------------


class DjiParseError(ValueError):
    """Malformed DJI DroneID payload."""


@dataclass(slots=True)
class DjiTelemetry:
    """Subcommand 0x10 - flight telemetry."""
    version: int
    sequence: int
    state_info: int
    serial: str | None
    lat: float | None
    lon: float | None
    altitude_m: float | None
    height_m: float | None
    v_north_mps: float | None
    v_east_mps: float | None
    v_up_mps: float | None
    pitch_deg: float | None
    roll_deg: float | None
    yaw_deg: float | None
    operator_lat: float | None
    operator_lon: float | None
    home_lat: float | None
    home_lon: float | None
    product_type: int | None
    uuid: str | None

    # Unscaled integers exactly as they appeared on the wire.
    #
    # Retained specifically for calibration: the SCALES above are hypotheses, and
    # resolving them means comparing a raw value against a known ground truth
    # ("app said 10 m, raw said 100 -> decimetres"). Without the raw value that
    # comparison is impossible. See docs/ops/04-calibration.md.
    raw: dict[str, int | None] = field(default_factory=dict)

    # Decoded state_info bits. Interpretation is partially inferred; treat as hints.
    @property
    def gps_valid(self) -> bool:
        return bool(self.state_info & 0x0001)

    @property
    def in_air(self) -> bool:
        return bool(self.state_info & 0x0002)

    @property
    def motors_on(self) -> bool:
        return bool(self.state_info & 0x0004)

    @property
    def home_point_set(self) -> bool:
        return bool(self.state_info & 0x0008)

    @property
    def speed_mps(self) -> float | None:
        if self.v_north_mps is None or self.v_east_mps is None:
            return None
        return math.hypot(self.v_north_mps, self.v_east_mps)

    @property
    def track_deg(self) -> float | None:
        if self.v_north_mps is None or self.v_east_mps is None:
            return None
        if self.v_north_mps == 0.0 and self.v_east_mps == 0.0:
            return None
        return math.degrees(math.atan2(self.v_east_mps, self.v_north_mps)) % 360.0


@dataclass(slots=True)
class DjiFlightPurpose:
    """Subcommand 0x11 - operator-entered flight description."""
    serial: str | None
    purpose: str | None


class _Reader:
    """Bounds-checked little-endian reader.

    Returns None past the end instead of raising: DJI truncates these payloads in
    the wild, and a short frame should yield partial telemetry rather than nothing.
    """

    __slots__ = ("buf", "pos")

    def __init__(self, buf: bytes, pos: int = 0) -> None:
        self.buf = buf
        self.pos = pos

    def _take(self, n: int) -> bytes | None:
        if self.pos + n > len(self.buf):
            self.pos = len(self.buf)
            return None
        out = self.buf[self.pos:self.pos + n]
        self.pos += n
        return out

    def u8(self) -> int | None:
        b = self._take(1)
        return b[0] if b else None

    def u16(self) -> int | None:
        b = self._take(2)
        return struct.unpack("<H", b)[0] if b else None

    def i16(self) -> int | None:
        b = self._take(2)
        return struct.unpack("<h", b)[0] if b else None

    def i32(self) -> int | None:
        b = self._take(4)
        return struct.unpack("<i", b)[0] if b else None

    def text(self, n: int) -> str | None:
        b = self._take(n)
        if not b:
            return None
        s = b.split(b"\x00", 1)[0].decode("ascii", errors="replace").strip()
        return s or None


def _angle(raw: int | None) -> float | None:
    """radians*1e7 -> degrees. 0 means no fix, not the Gulf of Guinea."""
    if raw is None or raw == 0:
        return None
    deg = raw / RAD_SCALE
    return deg if -180.0 <= deg <= 180.0 else None


def _scaled(raw: int | None, key: str) -> float | None:
    return None if raw is None else raw * SCALES[key]


def _parse_telemetry(r: _Reader) -> DjiTelemetry:
    version = r.u8()
    sequence = r.u16()
    state_info = r.u16()
    serial = r.text(16)

    raw_lon = r.i32()
    raw_lat = r.i32()
    altitude = r.i16()
    height = r.i16()
    v_north = r.i16()
    v_east = r.i16()
    v_up = r.i16()
    pitch = r.i16()
    roll = r.i16()
    yaw = r.i16()
    raw_op_lat = r.i32()
    raw_op_lon = r.i32()
    raw_home_lon = r.i32()
    raw_home_lat = r.i32()
    product_type = r.u8()

    uuid_len = r.u8()
    uuid = r.text(uuid_len) if uuid_len else None

    lat, lon = _angle(raw_lat), _angle(raw_lon)
    if lat is None or lon is None:
        lat = lon = None

    return DjiTelemetry(
        version=version or 0,
        sequence=sequence or 0,
        state_info=state_info or 0,
        serial=serial,
        lat=lat,
        lon=lon,
        altitude_m=_scaled(altitude, "altitude_m"),
        height_m=_scaled(height, "height_m"),
        v_north_mps=_scaled(v_north, "velocity_mps"),
        v_east_mps=_scaled(v_east, "velocity_mps"),
        v_up_mps=_scaled(v_up, "velocity_mps"),
        pitch_deg=_scaled(pitch, "attitude_deg"),
        roll_deg=_scaled(roll, "attitude_deg"),
        yaw_deg=_scaled(yaw, "attitude_deg"),
        operator_lat=_angle(raw_op_lat),
        operator_lon=_angle(raw_op_lon),
        home_lat=_angle(raw_home_lat),
        home_lon=_angle(raw_home_lon),
        product_type=product_type,
        uuid=uuid,
        raw={
            "altitude": altitude,
            "height": height,
            "v_north": v_north,
            "v_east": v_east,
            "v_up": v_up,
            "pitch": pitch,
            "roll": roll,
            "yaw": yaw,
            "lat": raw_lat,
            "lon": raw_lon,
            "operator_lat": raw_op_lat,
            "operator_lon": raw_op_lon,
        },
    )


def _parse_flight_purpose(r: _Reader) -> DjiFlightPurpose:
    serial = r.text(16)
    length = r.u8() or 0
    return DjiFlightPurpose(serial=serial, purpose=r.text(length) if length else None)


def parse_vendor_ie(ie_body: bytes) -> DjiTelemetry | DjiFlightPurpose | None:
    """Parse the body of an 802.11 vendor IE (tag 221).

    Returns None if this is not a DJI DroneID IE.

    Layout: OUI(3) | vendor byte(1) | subcommand(1) | payload
    """
    if len(ie_body) < 5 or ie_body[0:3] != DJI_OUI:
        return None

    subcommand = ie_body[4]
    r = _Reader(ie_body, 5)

    if subcommand == SUBCMD_TELEMETRY:
        return _parse_telemetry(r)
    if subcommand == SUBCMD_FLIGHT_PURPOSE:
        return _parse_flight_purpose(r)

    raise DjiParseError(f"unknown DJI DroneID subcommand 0x{subcommand:02x}")

"""Minimal 802.11 beacon / radiotap dissection.

Deliberately hand-rolled rather than pulling in Scapy's full stack: the capture loop
runs continuously and only ever needs the transmitter address and the tagged
parameters. Everything here is bounds-checked because monitor mode delivers
truncated and corrupt frames as a matter of course.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

RADIOTAP_PRESENT_TSFT = 1 << 0
RADIOTAP_PRESENT_FLAGS = 1 << 1
RADIOTAP_PRESENT_RATE = 1 << 2
RADIOTAP_PRESENT_CHANNEL = 1 << 3
RADIOTAP_PRESENT_FHSS = 1 << 4
RADIOTAP_PRESENT_DBM_ANTSIGNAL = 1 << 5
RADIOTAP_PRESENT_EXT = 1 << 31

TAG_SSID = 0
TAG_VENDOR_SPECIFIC = 221

FC_TYPE_MANAGEMENT = 0
FC_SUBTYPE_BEACON = 8


class Dot11ParseError(ValueError):
    """Frame too short or structurally invalid."""


@dataclass(slots=True)
class RadiotapInfo:
    length: int
    freq_mhz: int | None
    rssi_dbm: int | None


@dataclass(slots=True)
class Beacon:
    transmitter: str
    bssid: str
    ssid: str | None
    tags: list[tuple[int, bytes]]
    freq_mhz: int | None
    rssi_dbm: int | None

    def vendor_ies(self) -> list[bytes]:
        return [body for tag, body in self.tags if tag == TAG_VENDOR_SPECIFIC]


def _align(offset: int, boundary: int) -> int:
    rem = offset % boundary
    return offset + (boundary - rem) if rem else offset


def parse_radiotap(buf: bytes) -> RadiotapInfo:
    """Extract frequency and signal strength from a radiotap header.

    Only walks the first present-word's fields up to dBm antenna signal, which is
    all we need. Extended present words are skipped correctly so the header length
    is always honoured.
    """
    if len(buf) < 8:
        raise Dot11ParseError("radiotap header too short")

    _version, _pad, length = struct.unpack_from("<BBH", buf, 0)
    if length < 8 or length > len(buf):
        raise Dot11ParseError(f"implausible radiotap length {length}")

    present_words: list[int] = []
    offset = 4
    while True:
        if offset + 4 > length:
            return RadiotapInfo(length=length, freq_mhz=None, rssi_dbm=None)
        word = struct.unpack_from("<I", buf, offset)[0]
        present_words.append(word)
        offset += 4
        if not word & RADIOTAP_PRESENT_EXT:
            break

    present = present_words[0]
    freq_mhz: int | None = None
    rssi_dbm: int | None = None

    try:
        if present & RADIOTAP_PRESENT_TSFT:
            offset = _align(offset, 8) + 8
        if present & RADIOTAP_PRESENT_FLAGS:
            offset += 1
        if present & RADIOTAP_PRESENT_RATE:
            offset += 1
        if present & RADIOTAP_PRESENT_CHANNEL:
            offset = _align(offset, 2)
            freq_mhz = struct.unpack_from("<H", buf, offset)[0]
            offset += 4  # freq (2) + channel flags (2)
        if present & RADIOTAP_PRESENT_FHSS:
            offset += 2
        if present & RADIOTAP_PRESENT_DBM_ANTSIGNAL:
            rssi_dbm = struct.unpack_from("<b", buf, offset)[0]
    except struct.error:
        # Truncated radiotap: keep whatever we decoded. RSSI is nice to have,
        # not worth dropping a valid beacon over.
        pass

    return RadiotapInfo(length=length, freq_mhz=freq_mhz, rssi_dbm=rssi_dbm)


def _mac(buf: bytes, offset: int) -> str:
    return ":".join(f"{b:02x}" for b in buf[offset:offset + 6])


def parse_tags(buf: bytes) -> list[tuple[int, bytes]]:
    """Walk the tagged-parameter list.

    Stops cleanly on a truncated tag rather than raising: a beacon with a good
    DroneID IE followed by a mangled tail is still worth decoding.
    """
    tags: list[tuple[int, bytes]] = []
    offset = 0
    while offset + 2 <= len(buf):
        tag = buf[offset]
        length = buf[offset + 1]
        start = offset + 2
        if start + length > len(buf):
            break
        tags.append((tag, buf[start:start + length]))
        offset = start + length
    return tags


def parse_beacon(frame: bytes, with_radiotap: bool = True) -> Beacon | None:
    """Parse a captured frame. Returns None if it is not a beacon."""
    rt = parse_radiotap(frame) if with_radiotap else RadiotapInfo(0, None, None)
    body = frame[rt.length:]

    if len(body) < 24:
        return None

    fc = body[0]
    ftype = (fc >> 2) & 0x03
    subtype = (fc >> 4) & 0x0F
    if ftype != FC_TYPE_MANAGEMENT or subtype != FC_SUBTYPE_BEACON:
        return None

    # addr1 dest (4), addr2 transmitter (10), addr3 bssid (16)
    transmitter = _mac(body, 10)
    bssid = _mac(body, 16)

    # 24-byte MAC header + 12-byte fixed beacon params (timestamp, interval, caps)
    tags = parse_tags(body[36:])
    ssid = None
    for tag, value in tags:
        if tag == TAG_SSID:
            ssid = value.decode("utf-8", errors="replace") or None
            break

    return Beacon(
        transmitter=transmitter,
        bssid=bssid,
        ssid=ssid,
        tags=tags,
        freq_mhz=rt.freq_mhz,
        rssi_dbm=rt.rssi_dbm,
    )

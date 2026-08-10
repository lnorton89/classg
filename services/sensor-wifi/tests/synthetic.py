"""Build synthetic 802.11 beacon frames and PCAPs.

Exists so the capture/parse chain can be proven BEFORE a drone is in the air.
Discovering that radiotap parsing is broken while the aircraft is hovering is an
expensive way to find a bug.

Frame layout produced here mirrors what an mt7921u in monitor mode delivers:
radiotap header, then a management/beacon frame, then tagged parameters.
"""

from __future__ import annotations

import struct

RT_FLAGS = 1 << 1
RT_RATE = 1 << 2
RT_CHANNEL = 1 << 3
RT_DBM_ANTSIGNAL = 1 << 5

LINKTYPE_IEEE802_11_RADIOTAP = 127


def radiotap(freq_mhz: int = 2437, rssi_dbm: int = -62) -> bytes:
    """Minimal radiotap carrying channel frequency and signal strength.

    Field order and alignment follow the radiotap spec: fields appear in bit
    order, each aligned to its own natural boundary. Channel is 2-byte aligned.
    """
    present = RT_FLAGS | RT_RATE | RT_CHANNEL | RT_DBM_ANTSIGNAL
    body = b""
    body += struct.pack("<B", 0x00)                  # flags
    body += struct.pack("<B", 0x02)                  # rate
    body += struct.pack("<HH", freq_mhz, 0x00A0)     # channel freq + flags
    body += struct.pack("<b", rssi_dbm)              # dBm antenna signal
    header = struct.pack("<BBHI", 0, 0, 8 + len(body), present)
    return header + body


def _mac(text: str) -> bytes:
    return bytes(int(p, 16) for p in text.split(":"))


def tag(number: int, value: bytes) -> bytes:
    if len(value) > 255:
        raise ValueError("tag value too long")
    return bytes([number, len(value)]) + value


def beacon_frame(
    transmitter: str = "60:60:1f:aa:bb:cc",
    ssid: str = "Mavic-A1B2C3",
    vendor_ies: list[bytes] | None = None,
    freq_mhz: int = 2437,
    rssi_dbm: int = -62,
) -> bytes:
    """A full radiotap + beacon frame ready to feed to parse_beacon()."""
    addr = _mac(transmitter)
    mac_header = (
        bytes([0x80, 0x00])          # frame control: mgmt / beacon
        + struct.pack("<H", 0)       # duration
        + b"\xff" * 6                # addr1 destination (broadcast)
        + addr                       # addr2 transmitter
        + addr                       # addr3 bssid
        + struct.pack("<H", 0)       # sequence control
    )
    fixed = struct.pack("<QHH", 0, 100, 0x0431)  # timestamp, interval, capability

    tags = tag(0, ssid.encode())
    for ie in vendor_ies or []:
        tags += tag(221, ie)

    return radiotap(freq_mhz, rssi_dbm) + mac_header + fixed + tags


def write_pcap(path: str, frames: list[tuple[float, bytes]]) -> None:
    """Write frames as a radiotap-linktype PCAP."""
    with open(path, "wb") as fh:
        fh.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535,
                             LINKTYPE_IEEE802_11_RADIOTAP))
        for ts, data in frames:
            sec = int(ts)
            usec = round((ts - sec) * 1_000_000)
            fh.write(struct.pack("<IIII", sec, usec, len(data), len(data)))
            fh.write(data)

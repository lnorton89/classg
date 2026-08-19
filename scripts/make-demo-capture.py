#!/usr/bin/env python3
"""Write a synthetic DJI hover PCAP, so the pipeline can be proven with no drone.

The corpus in captures/ is gitignored on purpose (it may contain neighbours'
traffic), which leaves a fresh clone with nothing to replay. This builds one:
~4 Hz beacons on channel 6 carrying both an ASTM F3411 Remote ID IE and a DJI
DroneID IE -- the same frame recipe the sensor's own test suite uses
(services/sensor-wifi/tests/synthetic.py) -- plus a neighbour's access point
so the parsers have something to ignore. The aircraft hovers, then flies a
small square, so the map shows a moving track rather than a dot.

Run it with the sensor's venv from the repo root:

    services/sensor-wifi/.venv/bin/python scripts/make-demo-capture.py

Every byte is synthetic. Nothing here was received over the air, and nothing
transmits: the output is a file.
"""

from __future__ import annotations

import argparse
import math
import struct
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "sensor-wifi"))

from classg_wifi.parsers import dji, odid  # noqa: E402
from tests.synthetic import beacon_frame, write_pcap  # noqa: E402

DRONE_MAC = "60:60:1f:aa:bb:cc"
NEIGHBOUR_MAC = "aa:bb:cc:11:22:33"
SERIAL = b"1596F3B24C5D7E8F9A0B"

# Zurich, matching the sensor test suite's fixture coordinates.
BASE_LAT, BASE_LON = 47.3769, 8.5417


def _odid_ie(lat: float, lon: float) -> bytes:
    """ASTM F3411 message pack: Basic ID + Location, as a Wi-Fi vendor IE."""
    basic = bytes([0x02, 0x12]) + SERIAL.ljust(20, b"\x00") + b"\x00" * 3

    loc = bytearray(24)
    loc[0] = 2 << 4                        # airborne
    loc[1] = 90                            # track, degrees/2
    loc[2] = 40                            # speed -> 10 m/s
    loc[3] = struct.pack("<b", 4)[0]       # vertical speed -> 2 m/s
    struct.pack_into("<ii", loc, 4, int(lat * 1e7), int(lon * 1e7))
    struct.pack_into("<HHH", loc, 12, 3020, 3020, 2200)
    loc[18] = (5 << 4) | 11
    struct.pack_into("<H", loc, 20, 12345)
    location = bytes([(1 << 4) | 2]) + bytes(loc)

    pack = bytes([(0xF << 4) | 2]) + bytes([25, 2]) + basic + location
    return odid.ODID_OUI + bytes([odid.ODID_VENDOR_TYPE, 0x00]) + pack


def _dji_ie(lat: float, lon: float) -> bytes:
    """DJI DroneID telemetry (subcommand 0x10) as a Wi-Fi vendor IE."""
    raw_lat = int(lat * dji.RAD_SCALE)
    raw_lon = int(lon * dji.RAD_SCALE)

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


def _position(t: float, duration: float) -> tuple[float, float]:
    """Hover for the first third, then fly a small square (~100 m sides)."""
    if t < duration / 3:
        return BASE_LAT, BASE_LON
    leg = (t - duration / 3) / (duration * 2 / 3)  # 0..1 around the square
    side, frac = int(leg * 4) % 4, (leg * 4) % 1
    d = 0.0009  # ~100 m of latitude
    corners = [(0, 0), (d, 0), (d, d), (0, d)]
    y0, x0 = corners[side]
    y1, x1 = corners[(side + 1) % 4]
    return BASE_LAT + y0 + (y1 - y0) * frac, BASE_LON + x0 + (x1 - x0) * frac


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(REPO_ROOT / "captures" / "demo-hover.pcap"))
    ap.add_argument("--seconds", type=float, default=60.0, help="flight length")
    ap.add_argument(
        "--interval", type=float, default=0.24,
        help="beacon interval; 240 ms is what the reference DJI measured, not 1 Hz",
    )
    args = ap.parse_args()

    frames: list[tuple[float, bytes]] = []
    base = time.time() - args.seconds
    t = 0.0
    while t < args.seconds:
        lat, lon = _position(t, args.seconds)
        # RSSI wanders a little, like a real link
        rssi = -62 - int(3 * abs(math.sin(t)))
        frames.append((
            base + t,
            beacon_frame(
                transmitter=DRONE_MAC, ssid="Mavic-A1B2C3",
                vendor_ies=[_odid_ie(lat, lon), _dji_ie(lat, lon)],
                freq_mhz=2437, rssi_dbm=rssi,
            ),
        ))
        t += args.interval

    # A neighbour's AP beaconing at the standard ~10 Hz, so the demo also shows
    # the parsers ignoring ordinary traffic rather than flagging everything.
    t = 0.0
    while t < args.seconds:
        frames.append((
            base + t,
            beacon_frame(transmitter=NEIGHBOUR_MAC, ssid="HomeWiFi",
                         vendor_ies=[], freq_mhz=2437, rssi_dbm=-48),
        ))
        t += 0.1024

    frames.sort(key=lambda f: f[0])
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    write_pcap(str(out), frames)
    drone = sum(1 for _, f in frames if bytes.fromhex(DRONE_MAC.replace(":", "")) in f)
    print(f"wrote {out} -- {len(frames)} frames, {drone} from the synthetic drone")
    print("next: analyze it, then replay it into a running stack "
          "(see README, 'Prove the pipeline without hardware')")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

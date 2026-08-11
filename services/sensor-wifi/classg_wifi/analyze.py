"""Turn a first-flight PCAP into the numbers Milestone 0 actually needs.

`replay` proves the pipeline runs. This answers the questions that decide what
gets built next:

  - Which channel does the drone actually beacon on?   -> config/channels.yaml weights
  - What is the real beacon interval?                  -> channel dwell budget
  - What are the RAW DJI field values?                 -> docs/ops/04-calibration.md
  - Is operator location being broadcast?              -> retention handling

Every assumption baked into the current design is listed in docs/planning/roadmap.md
as a hypothesis. This is the tool that converts them into measurements.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any

from .parsers import dji, odid
from .parsers.dot11 import Beacon, Dot11ParseError, parse_beacon


@dataclass
class TransmitterStats:
    mac: str
    ssid: str | None = None
    channels: set[int] = field(default_factory=set)
    rssi: list[int] = field(default_factory=list)
    timestamps: list[float] = field(default_factory=list)
    odid_count: int = 0
    dji_count: int = 0
    last_odid: odid.OdidPayload | None = None
    last_dji: dji.DjiTelemetry | None = None
    dji_purpose: dji.DjiFlightPurpose | None = None

    @property
    def is_drone(self) -> bool:
        return bool(self.odid_count or self.dji_count)

    def intervals_ms(self) -> list[float]:
        if len(self.timestamps) < 2:
            return []
        ordered = sorted(self.timestamps)
        return [(b - a) * 1000.0 for a, b in pairwise(ordered)]


@dataclass
class AnalysisResult:
    frames: int = 0
    beacons: int = 0
    parse_errors: int = 0
    transmitters: dict[str, TransmitterStats] = field(default_factory=dict)

    @property
    def drones(self) -> list[TransmitterStats]:
        return [t for t in self.transmitters.values() if t.is_drone]


def _freq_to_channel(freq_mhz: int | None) -> int | None:
    if freq_mhz is None:
        return None
    if 2412 <= freq_mhz <= 2472:
        return (freq_mhz - 2412) // 5 + 1
    if freq_mhz == 2484:
        return 14
    if 5170 <= freq_mhz <= 5895:
        return (freq_mhz - 5000) // 5
    return None


def _ingest(result: AnalysisResult, beacon: Beacon, ts: float) -> None:
    stats = result.transmitters.get(beacon.transmitter)
    if stats is None:
        stats = TransmitterStats(mac=beacon.transmitter)
        result.transmitters[beacon.transmitter] = stats

    if beacon.ssid and not stats.ssid:
        stats.ssid = beacon.ssid
    ch = _freq_to_channel(beacon.freq_mhz)
    if ch is not None:
        stats.channels.add(ch)
    if beacon.rssi_dbm is not None:
        stats.rssi.append(beacon.rssi_dbm)

    saw_drone = False
    for ie in beacon.vendor_ies():
        try:
            payload = odid.parse_vendor_ie(ie)
        except odid.OdidParseError:
            result.parse_errors += 1
            payload = None
        if payload is not None:
            stats.odid_count += 1
            stats.last_odid = payload
            saw_drone = True
            continue

        try:
            dji_payload = dji.parse_vendor_ie(ie)
        except dji.DjiParseError:
            result.parse_errors += 1
            continue
        if isinstance(dji_payload, dji.DjiTelemetry):
            stats.dji_count += 1
            stats.last_dji = dji_payload
            saw_drone = True
        elif isinstance(dji_payload, dji.DjiFlightPurpose):
            stats.dji_purpose = dji_payload
            saw_drone = True

    # Only drone beacons feed the interval statistic. Mixing in the neighbours'
    # access points would produce a meaningless average.
    if saw_drone:
        stats.timestamps.append(ts)


def analyze_pcap(path: str) -> AnalysisResult:
    from scapy.utils import RawPcapReader  # optional 'replay' extra

    result = AnalysisResult()
    for raw, meta in RawPcapReader(path):
        result.frames += 1
        ts = float(getattr(meta, "sec", 0)) + float(getattr(meta, "usec", 0)) / 1e6
        try:
            beacon = parse_beacon(bytes(raw))
        except Dot11ParseError:
            result.parse_errors += 1
            continue
        if beacon is None:
            continue
        result.beacons += 1
        _ingest(result, beacon, ts)
    return result


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _fmt(value: Any, suffix: str = "") -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.2f}{suffix}"
    return f"{value}{suffix}"


def _coord(lat: float | None, lon: float | None) -> str:
    """Coordinates always get 7 decimals.

    Both protocols carry 1e-7 degree resolution, and the whole point of the
    position check is comparing against a known location -- at 2 decimals the
    error bar is about a kilometre, which would make the check meaningless.
    """
    if lat is None or lon is None:
        return "- (no GPS fix)"
    return f"{lat:.7f}, {lon:.7f}"


def render_report(result: AnalysisResult) -> str:
    out: list[str] = []
    add = out.append

    add("=" * 72)
    add("ClassG capture analysis")
    add("=" * 72)
    add(f"frames={result.frames}  beacons={result.beacons}  "
        f"transmitters={len(result.transmitters)}  parse_errors={result.parse_errors}")

    drones = result.drones
    if not drones:
        add("")
        add("NO DRONE BEACONS FOUND.")
        add("Rule out, in order: wrong channel (run first-capture.sh sweep), the")
        add("drone not broadcasting Wi-Fi Remote ID (check with the OpenDroneID")
        add("Android app - some models are Bluetooth-only), or too much distance.")
        return "\n".join(out)

    add(f"drone transmitters: {len(drones)}")

    for d in drones:
        add("")
        add("-" * 72)
        add(f"MAC {d.mac}   SSID {d.ssid or '-'}")
        add(f"  beacons: ODID={d.odid_count} DJI={d.dji_count}")
        add(f"  channels seen: {sorted(d.channels) or '-'}")
        if d.rssi:
            add(f"  RSSI: min={min(d.rssi)} max={max(d.rssi)} "
                f"median={statistics.median(d.rssi):.0f} dBm")

        intervals = d.intervals_ms()
        if intervals:
            add("")
            add("  BEACON INTERVAL  (drives channel dwell budget)")
            add(f"    median={statistics.median(intervals):.0f} ms  "
                f"min={min(intervals):.0f}  max={max(intervals):.0f}  n={len(intervals)}")
            rate = 1000.0 / statistics.median(intervals)
            add(f"    => ~{rate:.2f} Hz")
            if rate < 0.8 or rate > 1.5:
                add(f"    NOTE: the ~1 Hz design assumption looks wrong ({rate:.2f} Hz).")
                add("          Revisit dwell weights in config/channels.yaml.")

        if d.last_odid:
            _render_odid(add, d.last_odid)
        if d.last_dji:
            _render_dji(add, d.last_dji)
        if d.dji_purpose:
            add(f"  DJI flight purpose: {d.dji_purpose.purpose or '-'}")

    add("")
    add("=" * 72)
    if any(d.last_dji for d in drones):
        add("NEXT: copy the CALIBRATION block into docs/ops/04-calibration.md and")
        add("compare each raw value against what the DJI app showed at capture time.")
    else:
        add("No proprietary DJI Wi-Fi DroneID telemetry was present, so there are")
        add("no raw DJI fields to calibrate. Record the ASTM Remote ID observation,")
        add("channel, and beacon interval in docs/ops/04-calibration.md.")
    add("=" * 72)
    return "\n".join(out)


def _render_odid(add: Any, p: odid.OdidPayload) -> None:
    add("")
    add(f"  ASTM F3411 Remote ID  (protocol version {p.protocol_version})")
    if p.basic_id:
        add(f"    serial:   {p.basic_id.uas_id}")
        add(f"    id_type:  {p.basic_id.id_type}")
        add(f"    ua_type:  {p.basic_id.ua_type}")
        code = p.basic_id.manufacturer_code
        if code:
            vendor = p.basic_id.vendor or "unknown - add to CTA2063_MANUFACTURERS"
            add(f"    mfr code: {code} ({vendor})")
    if len(p.basic_ids) > 1:
        add(f"    ({len(p.basic_ids)} Basic ID messages present; "
            f"types: {[b.id_type for b in p.basic_ids]})")
    if p.location:
        loc = p.location
        add(f"    status:   {loc.status}")
        add(f"    position: {_coord(loc.lat, loc.lon)}")
        add(f"    altitude: geodetic={_fmt(loc.alt_geodetic_m, ' m')} "
            f"pressure={_fmt(loc.alt_pressure_m, ' m')} "
            f"height={_fmt(loc.height_m, ' m')} "
            f"({'AGL' if loc.height_is_agl else 'above takeoff'})")
        add(f"    motion:   speed={_fmt(loc.speed_mps, ' m/s')} "
            f"track={_fmt(loc.track_deg, ' deg')} "
            f"vs={_fmt(loc.vertical_speed_mps, ' m/s')}")
    if p.operator_id:
        add(f"    operator_id: {p.operator_id.operator_id}")
    if p.system:
        s = p.system
        if s.operator_lat is not None:
            add(f"    OPERATOR LOCATION: {_coord(s.operator_lat, s.operator_lon)}")
        else:
            # Observed on the real aircraft: early beacons carry the 0,0 sentinel
            # because the controller has no GPS fix yet. Absence here is normal
            # startup behaviour, not a decode failure.
            add("    operator location: not yet broadcast (no controller GPS fix)")
    if p.unknown_types:
        add(f"    unknown message types seen: {sorted(set(p.unknown_types))}")


def _render_dji(add: Any, t: dji.DjiTelemetry) -> None:
    add("")
    add(f"  DJI Wi-Fi DroneID  (version {t.version}, product_type {t.product_type})")
    add(f"    serial:   {t.serial}")
    add(f"    position: {_coord(t.lat, t.lon)}")
    add(f"    state:    gps_valid={t.gps_valid} in_air={t.in_air} "
        f"motors={t.motors_on} home_set={t.home_point_set}")
    if t.operator_lat is not None:
        add(f"    OPERATOR LOCATION: {_coord(t.operator_lat, t.operator_lon)}")
    if t.home_lat is not None:
        add(f"    home point: {_coord(t.home_lat, t.home_lon)}")

    add("")
    add("    CALIBRATION  ->  docs/ops/04-calibration.md")
    add("    Compare each RAW value against what the DJI app showed.")
    add(f"    {'field':<14}{'raw':>10}   {'decoded (current SCALES)':<28}{'scale':>8}")
    rows = [
        ("altitude", t.raw.get("altitude"), t.altitude_m, "altitude_m", "m"),
        ("height", t.raw.get("height"), t.height_m, "height_m", "m"),
        ("v_north", t.raw.get("v_north"), t.v_north_mps, "velocity_mps", "m/s"),
        ("v_east", t.raw.get("v_east"), t.v_east_mps, "velocity_mps", "m/s"),
        ("v_up", t.raw.get("v_up"), t.v_up_mps, "velocity_mps", "m/s"),
        ("pitch", t.raw.get("pitch"), t.pitch_deg, "attitude_deg", "deg"),
        ("roll", t.raw.get("roll"), t.roll_deg, "attitude_deg", "deg"),
        ("yaw", t.raw.get("yaw"), t.yaw_deg, "attitude_deg", "deg"),
    ]
    for name, raw_v, dec, scale_key, unit in rows:
        scale = dji.SCALES[scale_key]
        add(f"    {name:<14}{_fmt(raw_v):>10}   {_fmt(dec, ' ' + unit):<28}{scale:>8}")
    add("")
    add("    If the app said 10 m and raw reads 100, the unit is decimetres:")
    add("    set SCALES['height_m'] = 0.1 in parsers/dji.py.")


def summarize_channels(result: AnalysisResult) -> dict[int, int]:
    """Drone beacons per channel - the evidence for channels.yaml weights."""
    counts: dict[int, int] = defaultdict(int)
    for d in result.drones:
        for ch in d.channels:
            counts[ch] += d.odid_count + d.dji_count
    return dict(counts)

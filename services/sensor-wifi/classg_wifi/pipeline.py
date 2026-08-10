"""Frame -> Detection pipeline.

Deliberately separated from the capture loop so it can be driven from a PCAP file
in tests with no hardware. Corpus replay is the regression net for the parsers
(docs/planning/test-plan.md), and that only works if this is I/O-free.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from . import detection as det
from .fingerprint import FingerprintMatcher
from .parsers import dji, odid
from .parsers.dot11 import Beacon, Dot11ParseError, parse_beacon

log = logging.getLogger(__name__)


@dataclass
class PipelineStats:
    frames_seen: int = 0
    beacons: int = 0
    parse_errors: int = 0
    class_a: int = 0
    class_b: int = 0
    class_c: int = 0


class Pipeline:
    def __init__(
        self,
        sensor_id: str,
        matcher: FingerprintMatcher | None = None,
        rand: Callable[[int], bytes] = os.urandom,
    ) -> None:
        self.sensor_id = sensor_id
        self.matcher = matcher or FingerprintMatcher.empty()
        self.stats = PipelineStats()
        self._rand = rand

    def process_frame(self, frame: bytes) -> Iterator[dict[str, Any]]:
        self.stats.frames_seen += 1
        try:
            beacon = parse_beacon(frame)
        except Dot11ParseError:
            self.stats.parse_errors += 1
            return
        if beacon is None:
            return
        self.stats.beacons += 1
        yield from self.process_beacon(beacon)

    def process_beacon(self, beacon: Beacon) -> Iterator[dict[str, Any]]:
        drone_evidence = False

        for ie in beacon.vendor_ies():
            # Class A - ASTM F3411
            try:
                payload = odid.parse_vendor_ie(ie)
            except odid.OdidParseError as exc:
                self.stats.parse_errors += 1
                log.debug("ODID parse failed from %s: %s", beacon.transmitter, exc)
                payload = None
            if payload is not None:
                self.stats.class_a += 1
                drone_evidence = True
                yield det.from_odid(self.sensor_id, beacon, payload, ie, self._rand(10))
                continue

            # Class B - DJI Wi-Fi DroneID
            try:
                dji_payload = dji.parse_vendor_ie(ie)
            except dji.DjiParseError as exc:
                self.stats.parse_errors += 1
                log.debug("DJI parse failed from %s: %s", beacon.transmitter, exc)
                continue
            if dji_payload is not None:
                self.stats.class_b += 1
                drone_evidence = True
                yield det.from_dji(self.sensor_id, beacon, dji_payload, ie, self._rand(10))

        # Class C - fingerprint. Only worth emitting when nothing stronger was
        # found; a beacon that already yielded Remote ID gains nothing from an
        # OUI hint, and emitting both inflates the evidence count in fusion.
        if not drone_evidence:
            match = self.matcher.match(beacon.transmitter, beacon.ssid)
            if match is not None:
                vendor, reason = match
                self.stats.class_c += 1
                yield det.from_fingerprint(
                    self.sensor_id, beacon, vendor, reason, self._rand(10)
                )

    def saw_drone(self) -> bool:
        return bool(self.stats.class_a or self.stats.class_b)

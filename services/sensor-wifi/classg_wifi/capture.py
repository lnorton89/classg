"""Live monitor-mode capture loop.

This is the piece that makes ClassG a detector rather than a PCAP analyser.
Everything before this ran on replayed captures.

Shape of the loop:

    for each dwell:
        set the channel
        read frames until the dwell expires
        parse, publish, and tell the hopper what was seen

Three properties matter more than throughput at ~4 beacons/second:

1. **It never blocks.** A slow bus consumer must not stall the radio; the
   publisher drops rather than waits (ADR-0002).
2. **It reports health even when idle.** A heartbeat goes out on a timer
   whether or not anything was detected, because "no drones" and "sensor
   wedged" must be distinguishable (ADR-0003).
3. **It filters in the kernel.** The BPF filter means neighbours' data frames
   never reach userspace at all -- cheaper, and less to hold.

RECEIVE ONLY. This module opens a listening socket and never transmits.
"""

from __future__ import annotations

import contextlib
import errno
import logging
import select
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .bus import DetectionPublisher
from .hopper import ChannelHopper
from .pipeline import Pipeline

log = logging.getLogger(__name__)

# Management frames, beacon subtype. Compiled by libpcap and attached to the
# socket, so non-beacon traffic is discarded before it crosses into userspace.
BEACON_FILTER = "type mgt subtype beacon"

# A dwell is bounded by wall clock, but a burst of frames should not starve the
# channel-hop schedule. Read at most this many frames before re-checking time.
MAX_FRAMES_PER_POLL = 64


class CaptureError(RuntimeError):
    """The radio is unusable. Exit non-zero and let the supervisor restart."""


@dataclass
class CaptureStats:
    frames: int = 0
    beacons: int = 0
    detections: int = 0
    dwells: int = 0
    channel_errors: int = 0
    read_errors: int = 0
    started: float = field(default_factory=time.monotonic)

    def uptime_s(self) -> float:
        return time.monotonic() - self.started


def set_channel(iface: str, channel: int) -> bool:
    """Retune the adapter. Returns False rather than raising: a single failed
    hop should cost one dwell, not the whole capture."""
    try:
        res = subprocess.run(
            ["iw", "dev", iface, "set", "channel", str(channel)],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("channel %d: %s", channel, exc)
        return False
    if res.returncode != 0:
        log.warning("channel %d: %s", channel, res.stderr.strip() or res.returncode)
        return False
    return True


def open_socket(iface: str, bpf: str = BEACON_FILTER) -> Any:
    """Open a filtered layer-2 listening socket.

    Scapy is used only to compile the BPF and set up AF_PACKET -- hand-rolling
    BPF bytecode to avoid the dependency would be a lot of fragile code for no
    gain, and the analysis path already depends on scapy.
    """
    try:
        # scapy.arch MUST be imported before conf is used: it is what assigns
        # the platform's socket classes. Importing scapy.config alone yields a
        # conf whose L2listen is still None, and calling it fails with the
        # thoroughly unhelpful "'NoneType' object is not callable".
        import scapy.arch  # noqa: F401
        from scapy.config import conf
    except ImportError as exc:  # pragma: no cover - dependency check
        raise CaptureError(
            "live capture needs scapy: pip install '.[replay]'"
        ) from exc

    if conf.L2listen is None:  # pragma: no cover - platform guard
        raise CaptureError(
            "scapy has no layer-2 listening socket for this platform; "
            "live capture needs Linux with AF_PACKET"
        )

    try:
        return conf.L2listen(iface=iface, filter=bpf, monitor=True)
    except Exception as exc:
        raise CaptureError(
            f"could not open {iface} for capture: {exc}. "
            "Is it in monitor mode, and are you root? "
            "See scripts/setup-monitor.sh and docs/ops/05-troubleshooting.md"
        ) from exc


def run_capture(
    *,
    iface: str,
    hopper: ChannelHopper,
    pipeline: Pipeline,
    publisher: DetectionPublisher,
    heartbeat_s: float = 10.0,
    should_run: Callable[[], bool] = lambda: True,
    socket_factory: Callable[[str], Any] = open_socket,
) -> CaptureStats:
    """Capture until should_run() goes false.

    socket_factory is injectable so the loop can be tested against a fake radio
    without hardware -- see tests/test_capture.py.
    """
    stats = CaptureStats()
    sock = socket_factory(iface)
    last_heartbeat = 0.0
    consecutive_read_errors = 0

    log.info("capture starting on %s", iface)
    try:
        while should_run():
            spec = hopper.next_channel()
            if not set_channel(iface, spec.channel):
                stats.channel_errors += 1

            dwell_s = hopper.dwell_ms() / 1000.0
            dwell_started = time.monotonic()
            deadline = dwell_started + dwell_s
            saw_drone_this_dwell = False

            while should_run():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    ready, _, _ = select.select([sock], [], [], remaining)
                except OSError as exc:
                    if exc.errno == errno.EINTR:
                        continue
                    raise
                if not ready:
                    break

                for _ in range(MAX_FRAMES_PER_POLL):
                    frame = _recv(sock, stats)
                    if frame is None:
                        break
                    consecutive_read_errors = 0
                    stats.frames += 1
                    for detection in pipeline.process_frame(frame):
                        stats.detections += 1
                        publisher.publish(detection)
                        if detection["detection_class"] in ("A", "B"):
                            saw_drone_this_dwell = True
                    if time.monotonic() >= deadline:
                        break

                if stats.read_errors and stats.read_errors != consecutive_read_errors:
                    consecutive_read_errors = stats.read_errors
                    # A radio that has vanished fails every read. Give up and
                    # let the supervisor restart us rather than spinning.
                    if consecutive_read_errors > 50:
                        raise CaptureError(
                            f"{iface}: {consecutive_read_errors} consecutive read "
                            "failures; the adapter has probably gone away"
                        )

            stats.dwells += 1
            hopper.record_dwell(spec.channel, (time.monotonic() - dwell_started) * 1000.0)
            if saw_drone_this_dwell:
                hopper.on_drone_detected(spec.channel)

            now = time.monotonic()
            if now - last_heartbeat >= heartbeat_s:
                _heartbeat(publisher, stats, pipeline, hopper, iface)
                last_heartbeat = now
    finally:
        _close(sock)
        # One last heartbeat so a clean shutdown is distinguishable from a
        # crash in whatever is watching the bus.
        _heartbeat(publisher, stats, pipeline, hopper, iface, healthy=False,
                   reason="capture stopped")
        log.info(
            "capture stopped: %d frames, %d beacons, %d detections, %d dwells",
            stats.frames, pipeline.stats.beacons, stats.detections, stats.dwells,
        )
    return stats


def _recv(sock: Any, stats: CaptureStats) -> bytes | None:
    try:
        pkt = sock.recv()
    except Exception as exc:
        stats.read_errors += 1
        log.debug("read error: %s", exc)
        return None
    if pkt is None:
        return None
    try:
        return bytes(pkt)
    except Exception:
        stats.read_errors += 1
        return None


def _close(sock: Any) -> None:
    # A failure to close must not mask why the loop exited.
    with contextlib.suppress(Exception):
        sock.close()


def _heartbeat(
    publisher: DetectionPublisher,
    stats: CaptureStats,
    pipeline: Pipeline,
    hopper: ChannelHopper,
    iface: str,
    healthy: bool = True,
    reason: str = "",
) -> None:
    detail: dict[str, Any] = {
        "iface": iface,
        "channel": hopper.current.channel,
        "frames": stats.frames,
        "beacons": pipeline.stats.beacons,
        "detections": stats.detections,
        "class_a": pipeline.stats.class_a,
        "class_b": pipeline.stats.class_b,
        "class_c": pipeline.stats.class_c,
        "parse_errors": pipeline.stats.parse_errors,
        "channel_errors": stats.channel_errors,
        "read_errors": stats.read_errors,
        "uptime_s": round(stats.uptime_s(), 1),
        **hopper.efficiency_report(),
    }
    if reason:
        detail["reason"] = reason
    publisher.heartbeat(healthy=healthy, detail=detail)

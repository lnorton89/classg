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
import os
import select
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .bus import DetectionPublisher
from .hopper import ChannelHopper
from .pipeline import Pipeline
from .survey import SurveySampler

log = logging.getLogger(__name__)

# Management frames, beacon subtype. Compiled by libpcap and attached to the
# socket, so non-beacon traffic is discarded before it crosses into userspace.
BEACON_FILTER = "type mgt subtype beacon"

# A dwell is bounded by wall clock, but a burst of frames should not starve the
# channel-hop schedule. Read at most this many frames before re-checking time.
MAX_FRAMES_PER_POLL = 64

# Consecutive failed channel hops before the radio is declared gone. A few
# failures happen (a busy interface, a DFS channel); an unbroken run of them
# means the adapter is not there any more.
MAX_CONSECUTIVE_CHANNEL_ERRORS = 5


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
    hop should cost one dwell, not the whole capture.

    Logs at debug, not warning. A hop that fails because the adapter has gone
    is about to be reported far more usefully by the caller, and warning here
    produced one line per dwell forever -- pages of noise saying nothing.
    """
    try:
        res = subprocess.run(
            ["iw", "dev", iface, "set", "channel", str(channel)],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("channel %d: %s", channel, exc)
        return False
    if res.returncode != 0:
        log.debug("channel %d: %s", channel, res.stderr.strip() or res.returncode)
        return False
    return True


def interface_exists(iface: str) -> bool:
    return os.path.exists(f"/sys/class/net/{iface}")


def preflight(iface: str) -> None:
    """Fail with a specific, actionable message before touching the radio.

    Every one of these previously surfaced as the same scapy error, which named
    monitor mode and root as *possibilities* without checking either. Knowing
    which of the three it is turns a diagnosis into a command to run.
    """
    if not os.path.exists(f"/sys/class/net/{iface}"):
        available = sorted(os.listdir("/sys/class/net")) if os.path.isdir("/sys/class/net") else []
        raise CaptureError(
            f"interface {iface!r} does not exist (have: {', '.join(available) or 'none'}). "
            "Check the adapter enumerated and its driver bound:  lsusb   then  "
            "dmesg | grep -i mt7921. A driver that loads without producing an "
            "interface usually means missing firmware: apt install firmware-misc-nonfree"
        )

    if hasattr(os, "geteuid") and os.geteuid() != 0:
        raise CaptureError(
            "live capture needs root for AF_PACKET. Re-run with sudo, or use `make sense`."
        )

    mode = interface_mode(iface)
    if mode is None:
        log.warning("could not read the mode of %s; continuing", iface)
    elif mode != "monitor":
        raise CaptureError(
            f"{iface} is in {mode!r} mode, not monitor, so it will only see traffic "
            f"addressed to it. Fix with:  sudo ./scripts/setup-monitor.sh {iface}"
        )


def interface_mode(iface: str) -> str | None:
    """Return the interface's `iw` type, or None if it cannot be determined."""
    try:
        res = subprocess.run(
            ["iw", "dev", iface, "info"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    for line in res.stdout.splitlines():
        line = line.strip()
        if line.startswith("type "):
            return line.split(None, 1)[1].strip()
    return None


# ARPHRD_IEEE80211_RADIOTAP. A monitor-mode interface reports this as its
# hardware type, and scapy warns "Unable to guess type ... family=803" when it
# cannot map it to a dissector.
ARPHRD_IEEE80211_RADIOTAP = 803


def _register_radiotap(conf: Any) -> None:
    """Tell scapy that hardware type 803 is radiotap.

    Without this every start prints:

        WARNING: Unable to guess type (interface=wlan0 protocol=0x3 family=803)

    It is harmless -- we dissect radiotap ourselves in parsers/dot11.py and only
    ever wanted the bytes -- but an unexplained warning on a detector's startup
    is the kind of thing that gets ignored, and then the next one gets ignored
    too. Registering the mapping is better than teaching people to skip it.

    Best-effort: scapy's registry API has moved between versions, and a failure
    here costs nothing but the warning.
    """
    try:
        from scapy.layers.dot11 import RadioTap
    except ImportError:  # pragma: no cover - depends on scapy layout
        return
    try:
        conf.l2types.register(ARPHRD_IEEE80211_RADIOTAP, RadioTap)
    except Exception as exc:
        log.debug("could not register radiotap link type: %s", exc)


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

    _register_radiotap(conf)

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
    watchdog_s: float | None = None,
    should_run: Callable[[], bool] = lambda: True,
    socket_factory: Callable[[str], Any] = open_socket,
    surveyor: SurveySampler | None = None,
) -> CaptureStats:
    """Capture until should_run() goes false.

    socket_factory is injectable so the loop can be tested against a fake radio
    without hardware -- see tests/test_capture.py.

    surveyor is the channel-occupancy sampler. None means no survey is taken --
    which is what the tests want, and what a run on an adapter with no `iw`
    reduces to anyway.
    """
    stats = CaptureStats()
    if socket_factory is open_socket:
        preflight(iface)
    sock = socket_factory(iface)
    last_heartbeat = 0.0
    consecutive_read_errors = 0
    consecutive_channel_errors = 0
    tuned_channel: int | None = None

    # Shared with the watchdog thread, which cannot read the local above.
    #
    # Off unless asked for: tests drive this loop with heartbeat_s=0 and finish
    # in milliseconds, and a watchdog derived from that would kill the test
    # runner. The CLI turns it on for real captures, which is where wedging
    # happens.
    beat = _Heartbeat()
    stop_watchdog = (
        _start_watchdog(beat, timeout_s=watchdog_s, iface=iface)
        if watchdog_s and watchdog_s > 0
        else _noop
    )

    log.info("capture starting on %s", iface)
    try:
        while should_run():
            spec = hopper.next_channel()
            # Weighted selection can pick the same channel twice, and the
            # dedicated receiver has a one-channel plan. Calling `iw` anyway
            # creates a blind retune interval with no change in coverage.
            if tuned_channel == spec.channel:
                hop_ok = True
            else:
                hopper.record_hop()
                hop_ok = set_channel(iface, spec.channel)
                if hop_ok:
                    tuned_channel = spec.channel
            if hop_ok:
                consecutive_channel_errors = 0
            else:
                stats.channel_errors += 1
                consecutive_channel_errors += 1

                # An adapter that has been unplugged fails every hop. Previously
                # the loop logged a warning per dwell and carried on for ever:
                # pages of noise from a sensor that was, in every meaningful
                # sense, dead. That is precisely the silent failure ADR-0003
                # exists to prevent, so it now gives up and lets the supervisor
                # restart it.
                if not interface_exists(iface):
                    raise CaptureError(
                        f"{iface} disappeared mid-capture. The adapter was "
                        "unplugged, or its USB link dropped -- a brownout will "
                        "do it. Check  lsusb  and  dmesg  for a USB reset, then "
                        "re-run."
                    )
                if consecutive_channel_errors >= MAX_CONSECUTIVE_CHANNEL_ERRORS:
                    raise CaptureError(
                        f"{iface}: {consecutive_channel_errors} consecutive channel "
                        "hops failed while the interface still exists; the radio is "
                        "not usable. Check `sudo dmesg | tail` and that the "
                        "interface is still in monitor mode."
                    )
                if consecutive_channel_errors == 1:
                    log.warning(
                        "channel %d hop failed; will abort after %d consecutive failures",
                        spec.channel, MAX_CONSECUTIVE_CHANNEL_ERRORS,
                    )

            dwell_s = hopper.dwell_ms() / 1000.0
            dwell_started = time.monotonic()
            deadline = dwell_started + dwell_s
            saw_drone_this_dwell = False
            beacons_at_dwell_start = pipeline.stats.beacons

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

                    # The capture socket is BLOCKING, and select() above only
                    # promised that *one* frame was ready. Calling _recv() again
                    # without re-checking readiness parks the loop in recv until
                    # the next frame arrives -- which on a quiet channel is
                    # seconds away. The dwell deadline is checked after a read,
                    # never during one, so the loop sails past it, no heartbeat
                    # goes out, and the 45s watchdog kills a sensor whose radio
                    # was working the whole time. Observed on channel 1 with the
                    # ALFA: 12 beacons, then a wedge and a watchdog exit.
                    more, _, _ = select.select([sock], [], [], 0)
                    if not more:
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
            # Without this the per-channel beacon counts stayed empty for the
            # whole run while the total climbed into the thousands, so the
            # channel weights in channels.yaml had no evidence behind them.
            #
            # Only when the retune actually succeeded, though. A failed hop
            # leaves the radio on the PREVIOUS channel, and the dwell that
            # follows hears that channel's traffic -- crediting it to the
            # channel we failed to reach is how ch12 and ch13 accumulated
            # evidence on a US regdomain that forbids them outright. The
            # weights in channels.yaml are meant to be tuned from this, so
            # quietly wrong numbers here are worse than missing ones.
            #
            # record_dwell is deliberately still called: the hopper did schedule
            # that slot and the time was really spent, which is what the
            # efficiency figures measure.
            if hop_ok:
                hopper.on_beacon(spec.channel, pipeline.stats.beacons - beacons_at_dwell_start)
                if saw_drone_this_dwell:
                    hopper.on_drone_detected(spec.channel)

            now = time.monotonic()
            if now - last_heartbeat >= heartbeat_s:
                _heartbeat(publisher, stats, pipeline, hopper, iface,
                           surveyor=surveyor)
                last_heartbeat = now
                beat.mark()
    finally:
        _close(sock)
        stop_watchdog()
        # One last heartbeat so a clean shutdown is distinguishable from a
        # crash in whatever is watching the bus.
        _heartbeat(publisher, stats, pipeline, hopper, iface, healthy=False,
                   reason="capture stopped")
        log.info(
            "capture stopped: %d frames, %d beacons, %d detections, %d dwells",
            stats.frames, pipeline.stats.beacons, stats.detections, stats.dwells,
        )
    return stats


def _noop() -> None:
    """Stand-in for the watchdog shutdown when no watchdog is running."""


class _Heartbeat:
    """The time of the last published heartbeat, readable from another thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._at = time.monotonic()

    def mark(self) -> None:
        with self._lock:
            self._at = time.monotonic()

    def age_s(self) -> float:
        with self._lock:
            return time.monotonic() - self._at


def _start_watchdog(
    beat: _Heartbeat,
    *,
    timeout_s: float,
    iface: str,
    on_wedged: Callable[[int], None] = os._exit,
) -> Callable[[], None]:
    """Kill the process if the capture loop stops publishing heartbeats.

    Every bounded wait in the loop -- select(), the `iw` subprocess -- has a
    timeout, so in principle it cannot hang. In practice it does: when the USB
    transport dies mid-capture, a read or an `iw` call can land in
    uninterruptible sleep, where a timeout cannot reach it. Observed once for
    nearly five minutes: process alive, adapter still
    listed, interface still in monitor mode, and not one frame or heartbeat.

    That is the worst failure this system has, because everything looks fine.
    ADR-0003 says a sensor degrades visibly rather than wedging, and a process
    that has stopped reporting cannot report that it has stopped.

    on_wedged defaults to os._exit rather than raising: the main thread is stuck
    in a syscall and will never see an exception. Exiting makes the sensor
    visibly absent, which the health banner already knows how to say. It is a
    parameter so a test can prove the watchdog fires without killing pytest.
    """
    stop = threading.Event()

    def watch() -> None:
        while not stop.wait(timeout_s / 3):
            age = beat.age_s()
            if age > timeout_s:
                log.error(
                    "watchdog: no heartbeat for %.0fs on %s (limit %.0fs); the capture "
                    "loop is wedged, most likely on a USB transport that went away. "
                    "Exiting so the sensor reads as down instead of silently blind.",
                    age, iface, timeout_s,
                )
                on_wedged(1)
                return

    thread = threading.Thread(target=watch, name="capture-watchdog", daemon=True)
    thread.start()

    def shutdown() -> None:
        # Joined, not just signalled: a watchdog still running after its caller
        # has moved on can fire against a process that is already fine.
        stop.set()
        thread.join(timeout=timeout_s)

    return shutdown


def _recv(sock: Any, stats: CaptureStats) -> bytes | None:
    """Read one frame as raw bytes.

    recv_raw() is preferred over recv(): we parse radiotap and 802.11 ourselves
    (parsers/dot11.py), so letting scapy dissect every frame first is wasted
    work. It also avoids scapy's

        WARNING: Unable to guess type (interface=wlan0 protocol=0x3 family=803)

    which is scapy failing to map ARPHRD_IEEE80211_RADIOTAP to a dissector --
    harmless, since we only ever wanted the bytes, but noisy on every start.
    """
    try:
        if hasattr(sock, "recv_raw"):
            _cls, raw, _ts = sock.recv_raw()
            return raw if raw else None
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
    surveyor: SurveySampler | None = None,
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
    if surveyor is not None:
        # Sampled on the heartbeat rather than on its own timer: it is one
        # bounded subprocess and this is already the once-per-interval moment,
        # so it costs no extra thread and cannot land mid-dwell.
        survey = surveyor.sample()
        if survey:
            detail["survey"] = survey
        # Reported even when empty, because "this adapter has no survey" and
        # "this adapter has not been asked yet" look identical otherwise, and
        # the spectrum view has to tell an operator which one it is.
        if surveyor.available is not None:
            detail["survey_available"] = surveyor.available
        # And the reason, which is the difference between a missing package and
        # hardware that cannot do this at all -- one is worth fixing.
        if surveyor.reason:
            detail["survey_reason"] = surveyor.reason
            detail["survey_seen"] = surveyor.seen
    publisher.heartbeat(healthy=healthy, detail=detail)

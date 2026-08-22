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

from .bus import DetectionPublisher, PeerActivity
from .hopper import ChannelHopper, ChannelSpec
from .pipeline import Pipeline
from .survey import SurveySampler

log = logging.getLogger(__name__)

# Management frames, beacon subtype. Compiled by libpcap and attached to the
# socket, so non-beacon traffic is discarded before it crosses into userspace.
#
# Deliberate coverage gap: F3411 also permits Remote ID over Wi-Fi NAN, whose
# frames are management *action* frames, typically on channels 6 and 149. This
# filter never sees them. Widening it to "subtype beacon or subtype action"
# would push every nearby AP's action traffic across into Python -- a real CPU
# cost on a Pi, paid for a transport no aircraft in the capture corpus uses --
# so NAN stays invisible until a drone that needs it shows up.
BEACON_FILTER = "type mgt subtype beacon"

# A dwell is bounded by wall clock, but a burst of frames should not starve the
# channel-hop schedule. Read at most this many frames before re-checking time.
MAX_FRAMES_PER_POLL = 64

# Consecutive failed channel hops before the radio is declared gone. A few
# failures happen (a busy interface, a DFS channel); an unbroken run of them
# means the adapter is not there any more.
MAX_CONSECUTIVE_CHANNEL_ERRORS = 5

# Consecutive failed reads before the same conclusion. Genuinely consecutive:
# any successful frame resets the count. An earlier version compared against
# the lifetime total while calling it consecutive, so ~50 scattered read
# errors -- one an hour, millions of good frames in between -- restarted a
# healthy sensor with a message blaming the adapter.
MAX_CONSECUTIVE_READ_ERRORS = 50

# A radio SWEEPING 2.4 GHz is never actually silent: ordinary access points
# beacon every ~100 ms, so a hopping receiver that has heard NOTHING for minutes
# is broken, not lucky. Set well above one full sweep of the plan so a quiet
# 5 GHz dwell in the companion receiver's schedule cannot trip it on its own.
#
# A receiver PARKED on one channel is a different story and must not use this as
# a health signal: channels-primary.yaml pins the dedicated receiver to the
# drone's Remote ID channel, and if no access point in range beacons there,
# hearing nothing for hours is the correct and expected outcome. Measured on the
# ClassG Pi, where the parked receiver logged 0 frames across 116,788 dwells
# while its interface counters showed the radio itself receiving normally.
RX_STALL_UNHEALTHY_S = 120.0


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

    if hasattr(os, "geteuid") and os.geteuid() != 0 and not _has_packet_capabilities():
        raise CaptureError(
            "live capture needs root, or CAP_NET_RAW plus CAP_NET_ADMIN, for "
            "AF_PACKET and retuning. Re-run with sudo or use `make sense`; the "
            "systemd unit grants the capabilities via AmbientCapabilities."
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
    return _iw_dev_info_field(iface, "type ")


def interface_phy(iface: str) -> str | None:
    """The phy ("phy0") behind an interface, or None if it cannot be determined."""
    index = _iw_dev_info_field(iface, "wiphy ")
    return f"phy{index}" if index else None


def _iw_dev_info_field(iface: str, prefix: str) -> str | None:
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
        if line.startswith(prefix):
            return line.split(None, 1)[1].strip()
    return None


# Bit positions in the kernel's capability bitmap (linux/capability.h).
_CAP_NET_ADMIN = 12
_CAP_NET_RAW = 13


def _has_packet_capabilities() -> bool:
    """Whether the effective capability set covers AF_PACKET plus retuning.

    The systemd unit runs the sensor as an unprivileged user carrying
    AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN rather than as root. Checking
    euid alone would turn that process away with a message telling it to sudo.
    """
    try:
        with open("/proc/self/status", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("CapEff:"):
                    cap_eff = int(line.split()[1], 16)
                    return bool(
                        cap_eff >> _CAP_NET_RAW & 1 and cap_eff >> _CAP_NET_ADMIN & 1
                    )
    except (OSError, ValueError, IndexError):
        return False
    return False


def parse_phy_channels(text: str) -> set[int]:
    """Channel numbers `iw phy <phy> channels` reports as usable.

    Channel lines look like `* 2467 MHz [12] (disabled)`. A disabled channel
    is one the current regdomain forbids outright: retuning to it fails with
    -EINVAL, every time. `(no IR)` is different -- it restricts *initiating*
    radiation, which a receive-only monitor interface never does -- so those
    channels stay usable and stay in.
    """
    permitted: set[int] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("*"):
            continue
        start = line.find("[")
        end = line.find("]", start)
        if start < 0 or end < 0:
            continue
        try:
            channel = int(line[start + 1:end])
        except ValueError:
            continue
        if "(disabled)" not in line:
            permitted.add(channel)
    return permitted


def permitted_channels(iface: str) -> set[int] | None:
    """The channels this adapter will actually tune to, or None when unknowable."""
    phy = interface_phy(iface)
    if phy is None:
        return None
    try:
        res = subprocess.run(
            ["iw", "phy", phy, "channels"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    return parse_phy_channels(res.stdout) or None


def prune_channel_plan(channels: list[ChannelSpec], iface: str) -> list[ChannelSpec]:
    """Drop plan channels the adapter's regdomain forbids, logging each once.

    config/channels.yaml deliberately keeps channels that are legal somewhere
    -- 12 and 13 are fine in the EU -- so the filtering has to happen here,
    against the radio actually fitted, not by editing the config. Unfiltered,
    every visit to a forbidden channel fails the hop and still spends a full
    dwell listening to whatever channel the radio was left on: measured at
    4,247 failed-hop warnings in 24 h on a US regdomain. Worse, the weighted
    pick genuinely can draw a forbidden channel five times running, which
    aborted a healthy capture with a message blaming the radio.
    """
    permitted = permitted_channels(iface)
    if permitted is None:
        # Hopping and occasionally failing beats refusing to start because
        # `iw` is missing; the loop already tolerates individual failed hops.
        log.debug("could not read permitted channels for %s; using the plan as-is", iface)
        return channels
    kept = [spec for spec in channels if spec.channel in permitted]
    for spec in channels:
        if spec.channel not in permitted:
            log.info(
                "channel %d (%d MHz) is disabled in this adapter's regdomain; "
                "dropping it from the plan",
                spec.channel, spec.freq_mhz,
            )
    if not kept:
        raise CaptureError(
            f"every channel in the plan is disabled on {iface}: the regdomain "
            "and config/channels.yaml do not overlap. Check `iw reg get` and "
            "the plan."
        )
    return kept


# How long to wait for a companion adapter to enumerate before deciding it is
# not fitted. The two receivers race at boot: classg-sensor-wifi-tplink.service
# is ordered After= the primary, but the INTERFACE appears from udev, not from
# the unit, and the TP-Link enumerates behind a USB mode-switch. Deciding too
# early is not dangerous -- it widens the primary to the full plan, so the two
# radios duplicate coverage instead of splitting it -- but a solo unit pays this
# wait at every start, so it is a guess that wants measuring on real hardware
# rather than raising blindly.
COMPANION_WAIT_S = 15.0


@dataclass(frozen=True)
class PlanChoice:
    """Which channel plan this receiver ended up loading, and why.

    `fallback` is the one that matters downstream: it means this radio is
    covering the full plan alone because its companion was not there. The API
    reads it back out of the heartbeat to decide whether a missing second
    receiver is a supported build or a hole in the coverage -- see
    services/api/internal/health/health.go.
    """

    path: str
    fallback: bool = False
    companion_iface: str = ""
    companion_present: bool | None = None
    # Kept even when the split plan was chosen: peer coordination widens to it
    # later, and the name has to reach the heartbeat when it does.
    solo_path: str = ""

    def detail(self) -> dict[str, Any]:
        """The subset of this that belongs in every heartbeat."""
        out: dict[str, Any] = {
            "plan": os.path.basename(self.path),
            "plan_fallback": self.fallback,
        }
        if self.companion_iface:
            out["companion_iface"] = self.companion_iface
            out["companion_present"] = self.companion_present
        return out


class PlanState:
    """The channel plan this receiver is running right now, and why.

    Startup picks between the split plan and the solo plan by looking for the
    companion adapter (resolve_channel_plan). This carries that decision into
    the run and lets it move once: while a PEER is busy tracking, its sweep is
    suspended for escalation_hold_s at a time, so this receiver widens to the
    solo plan and keeps discovery alive. It narrows again when the peer goes
    quiet. ADR-0010 is the decision record.

    Not applied when this receiver is itself escalated: a radio holding a
    contact should keep holding it, and widening mid-track is how you drop the
    aircraft you already have.

    Nor when the companion was absent at startup -- there is nothing to widen
    to, because the solo plan is already loaded.
    """

    def __init__(
        self,
        choice: PlanChoice,
        split: list[ChannelSpec],
        solo: list[ChannelSpec] | None = None,
        min_hold_s: float = 30.0,
    ) -> None:
        self.choice = choice
        self.split = split
        self.solo = solo
        # Hysteresis. Escalation renews its lock on every further detection, so
        # a peer tracking one aircraft flickers between "active" and "quiet" at
        # the edge of the window. Rebuilding the plan on each flicker would
        # spend the dwell budget on retunes, which is the cost this is trying
        # to avoid in the first place.
        self.min_hold_s = min_hold_s
        self.widened = False
        self.swaps = 0
        self._changed_at: float | None = None

    @property
    def can_widen(self) -> bool:
        return self.solo is not None and not self.choice.fallback

    def reconcile(
        self,
        hopper: ChannelHopper,
        peer_active: bool,
        now: float,
    ) -> bool:
        """Swap the plan if the peer picture calls for it. Returns True if it did."""
        # Bound here rather than asserted below: `python -O` strips asserts, and
        # a type-narrowing aid that vanishes under a flag is not one.
        solo = self.solo
        if solo is None or self.choice.fallback:
            return False
        want = peer_active and not hopper.is_escalated
        if want == self.widened:
            return False
        if self._changed_at is not None and (now - self._changed_at) < self.min_hold_s:
            return False

        target = solo if want else self.split
        hopper.set_channels(target)
        self.widened = want
        self.swaps += 1
        self._changed_at = now
        log.info(
            "peer %s; %s to %d channels",
            "is tracking" if want else "is quiet",
            "widening" if want else "narrowing back",
            len(target),
        )
        return True

    def detail(self) -> dict[str, Any]:
        out = dict(self.choice.detail())
        if self.widened:
            # The startup file name would be a lie while this is true, and the
            # heartbeat is the only place /health and the operator can see it.
            out["plan"] = os.path.basename(self.solo_path)
        out["plan_widened_for_peer"] = self.widened
        out["plan_swaps"] = self.swaps
        return out

    @property
    def solo_path(self) -> str:
        return self.choice.solo_path or self.choice.path


def resolve_channel_plan(
    *,
    split_path: str,
    solo_path: str = "",
    companion_iface: str = "",
    wait_s: float = COMPANION_WAIT_S,
    poll_s: float = 0.5,
    exists: Callable[[str], bool] = interface_exists,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> PlanChoice:
    """Pick between the split plan and the solo plan by looking for the companion.

    The dual-receiver plans are deliberately partial. channels-primary.yaml is
    channels 6/1/11 only because channels-sweep.yaml takes everything else, and
    channels-sweep.yaml omits channel 6 -- the one channel a DJI was actually
    measured on -- because the primary camps there. Each is correct only while
    the other radio is running. Alone, either is a detector with a hole in it:
    no 5 GHz at all on the primary, no channel 6 at all on the companion.

    So which plan to load is a runtime question, not an install-time one. Ask
    the kernel whether the other radio is fitted, and widen to the full plan if
    it is not.

    Decided once, at startup, and reported in the heartbeat so /health can say
    so. A companion that vanishes an hour in does NOT re-widen this receiver:
    swapping plans mid-run means rebuilding the hopper's cumulative weights
    underneath the capture loop, and restarting to reload them drops frames
    during exactly the event you care about. The API surfaces that state
    instead of hiding it.
    """
    if not companion_iface or not solo_path:
        return PlanChoice(path=split_path, solo_path=solo_path)

    deadline = monotonic() + max(wait_s, 0.0)
    while True:
        if exists(companion_iface):
            log.info(
                "companion receiver %s is present; using the split plan %s",
                companion_iface, split_path,
            )
            return PlanChoice(
                path=split_path,
                companion_iface=companion_iface,
                companion_present=True,
                solo_path=solo_path,
            )
        remaining = deadline - monotonic()
        if remaining <= 0:
            break
        sleep(min(poll_s, remaining))

    log.warning(
        "companion receiver %s did not appear within %.0fs, so this radio is "
        "alone. Widening from %s to %s -- the split plans each cover only part "
        "of the spectrum and neither is safe on its own.",
        companion_iface, wait_s, split_path, solo_path,
    )
    return PlanChoice(
        path=solo_path,
        fallback=True,
        companion_iface=companion_iface,
        companion_present=False,
        solo_path=solo_path,
    )


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
    plan: PlanState | None = None,
    peers: PeerActivity | None = None,
) -> CaptureStats:
    """Capture until should_run() goes false.

    socket_factory is injectable so the loop can be tested against a fake radio
    without hardware -- see tests/test_capture.py.

    surveyor is the channel-occupancy sampler. None means no survey is taken --
    which is what the tests want, and what a run on an adapter with no `iw`
    reduces to anyway.

    plan describes which channel file this receiver loaded, whether it widened
    because its companion was missing, and whether it is widened right now
    because the companion is busy tracking. It rides on every heartbeat, because
    the consumer that needs it -- /health, deciding whether an absent second
    radio left a gap -- has no other way to learn it.

    peers is the coordination subscriber (ADR-0010) and is entirely optional.
    None means no coordination: the plan chosen at startup stands for the life
    of the process, which is what every single-radio unit does.
    """
    stats = CaptureStats()
    if socket_factory is open_socket:
        preflight(iface)
    sock = socket_factory(iface)
    last_heartbeat = 0.0
    last_frame_at = time.monotonic()
    frames_at_last_check = 0
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
            # Between dwells, never during one: set_channels rebuilds the
            # hopper's cumulative weights, and the loop is the only thread that
            # touches them. Polling here also means a silent or absent fusion
            # costs one non-blocking recv per dwell and nothing else.
            if peers is not None:
                # One clock read for the whole decision. Three separate calls
                # could have the activity window expire between the test and
                # the swap, which is a race that only shows up under load.
                at = time.monotonic()
                peers.poll(at)
                if plan is not None:
                    plan.reconcile(hopper, peers.peers_active(at), at)

            spec = hopper.next_channel()
            # Weighted selection can pick the same channel twice, and the
            # dedicated receiver has a one-channel plan. Calling `iw` anyway
            # creates a blind retune interval with no change in coverage.
            if tuned_channel == spec.channel:
                hop_ok = True
            else:
                # Time the retune rather than assume it. This is the only place
                # that can: the hopper never touches hardware, and the cost
                # differs per chipset -- mt7921u and rtl8852au are not the same
                # radio behind the same driver. Wall time around `iw` is the
                # honest figure for listening_fraction anyway, because the
                # subprocess spawn is blind time for this loop too.
                hop_started = time.monotonic()
                hop_ok = set_channel(iface, spec.channel)
                hopper.record_hop((time.monotonic() - hop_started) * 1000.0)
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
                    read_errors_before = stats.read_errors
                    frame = _recv(sock, stats)
                    if frame is None:
                        # _recv returns None for "nothing there" and for a
                        # failed read alike; only the failure -- visible as a
                        # bumped error counter -- advances the consecutive
                        # count. A radio that has vanished fails every read,
                        # so an unbroken run means give up and let the
                        # supervisor restart us rather than spinning.
                        if stats.read_errors > read_errors_before:
                            consecutive_read_errors += 1
                            if consecutive_read_errors > MAX_CONSECUTIVE_READ_ERRORS:
                                raise CaptureError(
                                    f"{iface}: {consecutive_read_errors} consecutive "
                                    "read failures; the adapter has probably gone away"
                                )
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
                if stats.frames != frames_at_last_check:
                    frames_at_last_check = stats.frames
                    last_frame_at = now

                # A receiver that is hearing frames demonstrably still has its
                # interface, so this costs nothing on the healthy path.
                #
                # It matters because the unplug check further up is only
                # reachable when a channel hop FAILS, and a single-channel plan
                # -- exactly what the dedicated primary receiver runs -- never
                # retunes. That branch can go unreached for the whole life of
                # the process, which is how a sensor whose adapter had been
                # unplugged for twelve hours kept publishing healthy heartbeats
                # with frames=0 while the API reported status ok: an empty map
                # that looked like a quiet sky.
                stalled_s = now - last_frame_at
                if stalled_s >= RX_STALL_UNHEALTHY_S:
                    # "Gone" is unambiguous whatever the plan looks like, and
                    # this is the only path that catches it on a parked
                    # receiver: the unplug check further up needs a FAILED hop,
                    # and a one-channel plan never retunes.
                    if not interface_exists(iface):
                        _heartbeat(publisher, stats, pipeline, hopper, iface,
                                   healthy=False, surveyor=surveyor, plan=plan, peers=peers,
                                   reason=f"{iface} disappeared mid-capture")
                        raise CaptureError(
                            f"{iface} disappeared mid-capture. The adapter was "
                            "unplugged, or its USB link dropped -- a brownout "
                            "will do it. Check  lsusb  and  dmesg  for a USB "
                            "reset, then re-run."
                        )
                    # Present but deaf. Only a SWEEPING plan proves a fault --
                    # see RX_STALL_UNHEALTHY_S. A wedged radio, monitor mode
                    # silently dropped, or an antenna that fell off. Reported
                    # rather than fatal: a restart does not screw an antenna
                    # back on, and the operator needs to see which it is.
                    elif len(hopper.channels) > 1:
                        _heartbeat(
                            publisher, stats, pipeline, hopper, iface,
                            healthy=False, surveyor=surveyor, plan=plan, peers=peers,
                            reason=(
                                f"no frames for {int(stalled_s)}s on {iface}; "
                                "the radio is up but hearing nothing. Check the "
                                "antenna and that monitor mode is still set: "
                                f"iw dev {iface} info"
                            ),
                        )
                    # Parked on one channel: silence is the expected outcome
                    # when nothing else transmits there, so say so without
                    # calling a working radio unhealthy.
                    else:
                        _heartbeat(publisher, stats, pipeline, hopper, iface,
                                   surveyor=surveyor, plan=plan, peers=peers,
                                   reason=(
                                       f"no frames for {int(stalled_s)}s, parked "
                                       f"on channel {hopper.current.channel}; "
                                       "expected if nothing else transmits there"
                                   ))
                else:
                    _heartbeat(publisher, stats, pipeline, hopper, iface,
                               surveyor=surveyor, plan=plan, peers=peers)
                last_heartbeat = now
                beat.mark()
    finally:
        _close(sock)
        stop_watchdog()
        # One last heartbeat so a clean shutdown is distinguishable from a
        # crash in whatever is watching the bus.
        _heartbeat(publisher, stats, pipeline, hopper, iface, healthy=False,
                   plan=plan, peers=peers, reason="capture stopped")
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
    plan: PlanState | None = None,
    peers: PeerActivity | None = None,
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
    if plan is not None:
        detail.update(plan.detail())
    if peers is not None:
        detail.update(peers.detail(time.monotonic()))
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

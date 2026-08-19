"""Live capture loop tests, against a fake radio.

The loop is the piece that makes this a detector rather than a PCAP analyser,
and it is the hardest thing to test on hardware -- it needs a monitor-mode
adapter, root, and a drone in the air. Injecting the socket lets the parts that
actually go wrong be tested here: dwell timing, escalation, heartbeats while
idle, and what happens when the radio disappears.
"""

from __future__ import annotations

import struct
import time
from typing import Any

import pytest

from classg_wifi import capture
from classg_wifi.bus import DetectionPublisher
from classg_wifi.hopper import ChannelHopper, ChannelSpec
from classg_wifi.pipeline import Pipeline
from tests.synthetic import beacon_frame
from tests.test_analyze import _dji_ie, _odid_ie


class FakeRadio:
    """A socket that yields prepared frames then blocks (returns nothing)."""

    def __init__(self, frames: list[bytes], fail_after: int | None = None) -> None:
        self.frames = list(frames)
        self.fail_after = fail_after
        self.reads = 0
        self.closed = False

    def recv(self) -> Any:
        self.reads += 1
        if self.fail_after is not None and self.reads > self.fail_after:
            raise OSError("adapter went away")
        if not self.frames:
            return None
        return _Raw(self.frames.pop(0))

    def fileno(self) -> int:  # select() needs something; patched out below
        return 0

    def close(self) -> None:
        self.closed = True


class _Raw:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def __bytes__(self) -> bytes:
        return self.data


class RawRadio(FakeRadio):
    """Speaks recv_raw(), as scapy's real socket does.

    The preferred path: we dissect radiotap ourselves, so scapy parsing every
    frame first is wasted work and emits a spurious "unable to guess type"
    warning for radiotap link layers.
    """

    def recv_raw(self, x: int = 0xFFFF) -> tuple[Any, bytes | None, float | None]:
        self.reads += 1
        if self.fail_after is not None and self.reads > self.fail_after:
            raise OSError("adapter went away")
        if not self.frames:
            return (None, None, None)
        return (None, self.frames.pop(0), 0.0)


class RecordingPublisher(DetectionPublisher):
    """Captures what would go on the bus instead of opening a socket."""

    def __init__(self) -> None:
        self.published: list[dict[str, Any]] = []
        self.heartbeats: list[dict[str, Any]] = []
        self.sensor_id = "wifi-test"

    def publish(self, detection: dict[str, Any]) -> bool:
        self.published.append(detection)
        return True

    def heartbeat(self, healthy: bool, detail: dict[str, Any] | None = None) -> None:
        self.heartbeats.append({"healthy": healthy, "detail": detail or {}})

    def close(self) -> None:
        pass


@pytest.fixture(autouse=True)
def no_hardware(monkeypatch):
    """Never shell out to iw, and make select() always report readable."""
    monkeypatch.setattr(capture, "set_channel", lambda iface, ch: True)
    monkeypatch.setattr(capture.select, "select", lambda r, w, x, t: (r, [], []))


def make_hopper() -> ChannelHopper:
    return ChannelHopper(
        [ChannelSpec(channel=6, freq_mhz=2437, weight=1.0)],
        base_dwell_ms=10,
        escalation_hold_s=5.0,
    )


def drone_frame() -> bytes:
    return beacon_frame(
        transmitter="60:60:1f:aa:bb:cc",
        ssid="RID-1581F0000000FAKE0001",
        vendor_ies=[_odid_ie(), _dji_ie()],
    )


def run_once(radio: FakeRadio, hopper: ChannelHopper | None = None):
    """Run exactly one dwell."""
    hopper = hopper or make_hopper()
    pipeline = Pipeline(sensor_id="wifi-test")
    pub = RecordingPublisher()
    dwells = {"n": 0}

    def should_run() -> bool:
        # Stop after a single dwell so the test is bounded.
        return dwells["n"] < 1

    original = hopper.record_dwell

    def counting_record(channel: int, ms: float) -> None:
        dwells["n"] += 1
        original(channel, ms)

    hopper.record_dwell = counting_record  # type: ignore[method-assign]

    stats = capture.run_capture(
        iface="wlan-test",
        hopper=hopper,
        pipeline=pipeline,
        publisher=pub,
        heartbeat_s=0.0,
        should_run=should_run,
        socket_factory=lambda _iface: radio,
    )
    return stats, pub, pipeline, hopper


class TestDetection:
    def test_publishes_detections_from_captured_frames(self):
        radio = FakeRadio([drone_frame()])
        stats, pub, pipeline, _ = run_once(radio)

        assert stats.frames >= 1
        assert pipeline.stats.class_a >= 1, "the ODID IE should decode"
        classes = {d["detection_class"] for d in pub.published}
        assert "A" in classes

    def test_non_drone_beacons_produce_no_class_a(self):
        radio = FakeRadio([beacon_frame(ssid="HomeWiFi", vendor_ies=[])])
        _, pub, _, _ = run_once(radio)
        assert not [d for d in pub.published if d["detection_class"] in ("A", "B")]

    def test_a_drone_escalates_the_dwell(self):
        """Keeping an existing track continuous beats finding a second one."""
        hopper = make_hopper()
        assert not hopper.is_escalated
        run_once(FakeRadio([drone_frame()]), hopper)
        assert hopper.is_escalated, "a Class A detection must lock dwell to the channel"

    def test_quiet_sky_does_not_escalate(self):
        hopper = make_hopper()
        run_once(FakeRadio([beacon_frame(ssid="HomeWiFi", vendor_ies=[])]), hopper)
        assert not hopper.is_escalated


def test_single_channel_plan_only_tunes_once(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(capture, "set_channel", lambda _iface, ch: calls.append(ch) or True)
    hopper = make_hopper()
    dwells = {"n": 0}
    original = hopper.record_dwell

    def counting(channel: int, ms: float) -> None:
        dwells["n"] += 1
        original(channel, ms)

    hopper.record_dwell = counting  # type: ignore[method-assign]
    capture.run_capture(
        iface="wlan-test",
        hopper=hopper,
        pipeline=Pipeline(sensor_id="wifi-test"),
        publisher=RecordingPublisher(),
        heartbeat_s=0.0,
        should_run=lambda: dwells["n"] < 3,
        socket_factory=lambda _iface: FakeRadio([]),
    )

    assert calls == [6]
    assert hopper.efficiency_report()["hops"] == 1


class TestHealth:
    def test_heartbeats_even_with_no_detections(self):
        """The whole point of ADR-0003: silence must be distinguishable from death."""
        _, pub, _, _ = run_once(FakeRadio([]))
        assert pub.heartbeats, "a sensor that detects nothing must still report in"

    def test_heartbeat_carries_diagnostics(self):
        _, pub, _, _ = run_once(FakeRadio([drone_frame()]))
        detail = pub.heartbeats[-1]["detail"]
        for key in ("iface", "channel", "frames", "beacons", "listening_fraction"):
            assert key in detail, f"heartbeat missing {key}"

    def test_final_heartbeat_marks_the_sensor_down(self):
        """A clean stop must not leave /health believing the radio is fine."""
        _, pub, _, _ = run_once(FakeRadio([]))
        assert pub.heartbeats[-1]["healthy"] is False
        assert "stopped" in pub.heartbeats[-1]["detail"].get("reason", "")

    def test_socket_is_closed(self):
        radio = FakeRadio([])
        run_once(radio)
        assert radio.closed


class TestFailures:
    def test_a_vanished_adapter_raises_rather_than_spinning(self):
        radio = FakeRadio([], fail_after=0)
        hopper = ChannelHopper(
            [ChannelSpec(channel=6, freq_mhz=2437, weight=1.0)], base_dwell_ms=200
        )
        pipeline = Pipeline(sensor_id="wifi-test")
        pub = RecordingPublisher()

        with pytest.raises(capture.CaptureError, match="gone away"):
            capture.run_capture(
                iface="wlan-test",
                hopper=hopper,
                pipeline=pipeline,
                publisher=pub,
                heartbeat_s=0.0,
                socket_factory=lambda _iface: radio,
            )
        # And it says so on the bus before dying.
        assert pub.heartbeats and pub.heartbeats[-1]["healthy"] is False

    def test_a_failed_channel_hop_costs_one_dwell_not_the_capture(self, monkeypatch):
        # The interface is still present -- one bad hop must not end the capture.
        # An unbroken run of them is a different case, covered by
        # TestAdapterDisappears.
        monkeypatch.setattr(capture, "set_channel", lambda iface, ch: False)
        monkeypatch.setattr(capture, "interface_exists", lambda iface: True)
        stats, _, _, _ = run_once(FakeRadio([drone_frame()]))
        assert stats.channel_errors == 1
        assert stats.dwells == 1, "the loop must keep going"

    def test_a_failed_hop_does_not_credit_beacons_to_the_channel(self, monkeypatch):
        """A failed retune leaves the radio on the PREVIOUS channel.

        The dwell still happens and still hears traffic, but it is the old
        channel's traffic. Crediting it to the channel we never reached is how
        ch12 and ch13 accumulated beacon evidence on a US regdomain that
        forbids them -- and `config/channels.yaml` says to tune the weights
        from exactly these counts, so a wrong number is worse than none.
        """
        monkeypatch.setattr(capture, "set_channel", lambda iface, ch: False)
        monkeypatch.setattr(capture, "interface_exists", lambda iface: True)

        hopper = make_hopper()
        stats, _, pipeline, hopper = run_once(FakeRadio([drone_frame()]), hopper)

        assert stats.channel_errors == 1
        assert pipeline.stats.beacons >= 1, "the frame was still received"
        assert hopper.stats.beacons == {}, (
            "beacons heard on the old channel were credited to the one the hop "
            "failed to reach"
        )
        assert hopper.stats.drone_hits == {}, "same for the drone-hit evidence"

    def test_malformed_frames_do_not_stop_the_loop(self):
        radio = FakeRadio([b"\x00\x01\x02", struct.pack("<I", 0xDEADBEEF), drone_frame()])
        stats, pub, _, _ = run_once(radio)
        assert stats.frames == 3
        assert any(d["detection_class"] == "A" for d in pub.published)

    def test_scattered_read_errors_never_abort_a_working_radio(self):
        """Only an UNBROKEN run of read failures means the adapter is gone.

        The counter used to be overwritten with the lifetime total at the end
        of every dwell, so ~50 read errors spread across days of good frames
        raised CaptureError claiming "consecutive read failures" -- and
        systemd's restart turned that into a mysterious periodic restart of a
        perfectly healthy sensor.
        """

        class FlakyRadio(FakeRadio):
            """Every other read fails; the frames between are fine."""

            def recv_raw(self, x: int = 0xFFFF):
                self.reads += 1
                if self.reads % 2:
                    raise OSError("transient read error")
                return (None, drone_frame(), 0.0)

        radio = FlakyRadio([])
        stats = capture.run_capture(
            iface="wlan-test",
            hopper=make_hopper(),
            pipeline=Pipeline(sensor_id="wifi-test"),
            publisher=RecordingPublisher(),
            heartbeat_s=0.0,
            should_run=lambda: radio.reads < 4 * capture.MAX_CONSECUTIVE_READ_ERRORS,
            socket_factory=lambda _iface: radio,
        )
        assert stats.read_errors > capture.MAX_CONSECUTIVE_READ_ERRORS, (
            "the test never accumulated enough scattered errors to prove anything"
        )
        assert stats.frames > capture.MAX_CONSECUTIVE_READ_ERRORS


class TestSocketOpen:
    """open_socket was the one path the fake radio never exercised, which is
    exactly where the bug was: importing scapy.config alone leaves
    conf.L2listen as None, and calling it fails with "'NoneType' object is not
    callable" -- a message that sends you hunting for a hardware fault."""

    def test_scapy_provides_a_layer2_socket_after_our_import(self):
        pytest.importorskip("scapy")
        import sys

        if not sys.platform.startswith("linux"):
            pytest.skip("AF_PACKET listening sockets are Linux-only")

        # Mirrors capture.open_socket's imports exactly.
        import scapy.arch  # noqa: F401
        from scapy.config import conf

        assert conf.L2listen is not None, (
            "scapy.arch must be imported before conf is used, or capture cannot "
            "open a socket"
        )
        assert callable(conf.L2listen)

    def test_missing_socket_class_gives_an_actionable_error(self, monkeypatch):
        pytest.importorskip("scapy")
        import scapy.arch  # noqa: F401
        from scapy.config import conf

        monkeypatch.setattr(conf, "L2listen", None)
        with pytest.raises(capture.CaptureError, match="AF_PACKET"):
            capture.open_socket("wlan-test")

    def test_open_failure_names_monitor_mode_and_root(self, monkeypatch):
        pytest.importorskip("scapy")
        import scapy.arch  # noqa: F401
        from scapy.config import conf

        def boom(**_kwargs):
            raise OSError("Operation not permitted")

        monkeypatch.setattr(conf, "L2listen", boom)
        with pytest.raises(capture.CaptureError) as excinfo:
            capture.open_socket("wlan-test")
        message = str(excinfo.value)
        assert "monitor mode" in message and "root" in message


class TestPreflight:
    """Three different causes previously produced one scapy error that named
    monitor mode and root as possibilities without checking either."""

    def test_missing_interface_names_how_to_check_the_adapter(self, monkeypatch):
        monkeypatch.setattr(capture.os.path, "exists", lambda p: False)
        monkeypatch.setattr(capture.os.path, "isdir", lambda p: False)
        with pytest.raises(capture.CaptureError) as excinfo:
            capture.preflight("wlan9")
        assert "lsusb" in str(excinfo.value)

    def test_managed_mode_names_the_fix(self, monkeypatch):
        monkeypatch.setattr(capture.os.path, "exists", lambda p: True)
        monkeypatch.setattr(capture.os, "geteuid", lambda: 0, raising=False)
        monkeypatch.setattr(capture, "interface_mode", lambda iface: "managed")
        with pytest.raises(capture.CaptureError) as excinfo:
            capture.preflight("wlan0")
        message = str(excinfo.value)
        assert "managed" in message and "setup-monitor.sh" in message

    def test_non_root_is_reported_as_such(self, monkeypatch):
        if not hasattr(capture.os, "geteuid"):
            pytest.skip("no geteuid on this platform; the check is skipped there too")
        monkeypatch.setattr(capture.os.path, "exists", lambda p: True)
        monkeypatch.setattr(capture.os, "geteuid", lambda: 1000)
        monkeypatch.setattr(capture, "_has_packet_capabilities", lambda: False)
        with pytest.raises(capture.CaptureError, match="root"):
            capture.preflight("wlan0")

    def test_ambient_capabilities_satisfy_the_privilege_check(self, monkeypatch):
        """The hardened systemd unit runs unprivileged with CAP_NET_RAW and
        CAP_NET_ADMIN. A euid-only check would refuse to start it."""
        if not hasattr(capture.os, "geteuid"):
            pytest.skip("no geteuid on this platform; the check is skipped there too")
        monkeypatch.setattr(capture.os.path, "exists", lambda p: True)
        monkeypatch.setattr(capture.os, "geteuid", lambda: 1000)
        monkeypatch.setattr(capture, "_has_packet_capabilities", lambda: True)
        monkeypatch.setattr(capture, "interface_mode", lambda iface: "monitor")
        capture.preflight("wlan0")  # must not raise

    def test_monitor_mode_passes(self, monkeypatch):
        monkeypatch.setattr(capture.os.path, "exists", lambda p: True)
        monkeypatch.setattr(capture.os, "geteuid", lambda: 0, raising=False)
        monkeypatch.setattr(capture, "interface_mode", lambda iface: "monitor")
        capture.preflight("wlan0")  # must not raise


class TestRawReadPath:
    """recv_raw() is what the real socket provides; recv() is the fallback."""

    def test_recv_raw_is_preferred_and_yields_detections(self):
        radio = RawRadio([drone_frame()])
        stats, pub, pipeline, _ = run_once(radio)
        assert stats.frames >= 1
        assert pipeline.stats.class_a >= 1
        assert any(d["detection_class"] == "A" for d in pub.published)

    def test_recv_fallback_still_works(self):
        """A socket without recv_raw must still be usable."""
        radio = FakeRadio([drone_frame()])
        assert not hasattr(radio, "recv_raw")
        _, pub, pipeline, _ = run_once(radio)
        assert pipeline.stats.class_a >= 1
        assert any(d["detection_class"] == "A" for d in pub.published)


class TestDrainStopsAtWhatSelectPromised:
    """The capture socket is blocking, and select() only ever promises that ONE
    frame is ready. Draining further without re-checking readiness parks the
    loop inside recv() until the next frame arrives -- seconds away on a quiet
    channel. The dwell deadline is only checked *between* reads, never during
    one, so the loop overruns the dwell, stops emitting heartbeats, and the
    watchdog kills a sensor whose radio was working fine.

    Seen on hardware: channel 1, 12 beacons, then a wedge and a watchdog exit
    with no USB error and the interface still in monitor mode.
    """

    def test_does_not_read_past_a_drained_socket(self, monkeypatch):
        # One frame arrives, then the channel goes quiet: the first dwell poll
        # is readable, the drain re-check (timeout == 0) is not, and no further
        # frame shows up before the dwell expires.
        polls = {"n": 0}

        def one_frame_then_quiet(r, w, x, timeout):
            if timeout == 0:
                return [], [], []
            polls["n"] += 1
            return (r, [], []) if polls["n"] == 1 else ([], [], [])

        monkeypatch.setattr(capture.select, "select", one_frame_then_quiet)

        radio = RawRadio([drone_frame()])
        _, _, pipeline, _ = run_once(radio)

        assert pipeline.stats.beacons >= 1, "the one available frame was missed"
        assert radio.reads == 1, (
            "read past what select() promised; on a blocking socket that is a "
            "wedge, not merely a wasted syscall"
        )


class TestAdapterDisappears:
    """The failure that actually happened on hardware: the adapter dropped
    mid-capture, every channel hop returned ENODEV, and the loop logged a
    warning per dwell and carried on for ever -- a sensor that was dead but
    looked alive, which is the exact thing ADR-0003 forbids."""

    def _run(self, monkeypatch, iface_exists: bool):
        monkeypatch.setattr(capture, "set_channel", lambda iface, ch: False)
        monkeypatch.setattr(capture, "interface_exists", lambda iface: iface_exists)
        pub = RecordingPublisher()
        with pytest.raises(capture.CaptureError) as excinfo:
            capture.run_capture(
                iface="wlan-test",
                hopper=make_hopper(),
                pipeline=Pipeline(sensor_id="wifi-test"),
                publisher=pub,
                heartbeat_s=0.0,
                socket_factory=lambda _iface: FakeRadio([]),
            )
        return excinfo.value, pub

    def test_vanished_interface_aborts_immediately(self, monkeypatch):
        err, pub = self._run(monkeypatch, iface_exists=False)
        assert "disappeared mid-capture" in str(err)
        assert "lsusb" in str(err), "must name the fix, not just the symptom"
        # And the bus is told, so /health shows a broken sensor not a quiet sky.
        assert pub.heartbeats and pub.heartbeats[-1]["healthy"] is False

    def test_present_but_unusable_radio_aborts_after_a_bounded_run(self, monkeypatch):
        err, _ = self._run(monkeypatch, iface_exists=True)
        assert "consecutive channel" in str(err)

    def test_an_occasional_failed_hop_does_not_abort(self, monkeypatch):
        """A few failures are normal; only an unbroken run means the radio is gone."""
        calls = {"n": 0}

        def flaky(iface: str, ch: int) -> bool:
            calls["n"] += 1
            return calls["n"] % 3 != 0  # every third hop fails

        monkeypatch.setattr(capture, "set_channel", flaky)
        monkeypatch.setattr(capture, "interface_exists", lambda iface: True)

        plans = [
            ChannelSpec(channel=1, freq_mhz=2412, weight=1.0),
            ChannelSpec(channel=6, freq_mhz=2437, weight=1.0),
        ]
        hopper = ChannelHopper(plans, base_dwell_ms=10)
        pipeline = Pipeline(sensor_id="wifi-test")
        pub = RecordingPublisher()
        dwells = {"n": 0}
        original = hopper.record_dwell

        def counting(channel: int, ms: float) -> None:
            dwells["n"] += 1
            original(channel, ms)

        hopper.record_dwell = counting  # type: ignore[method-assign]
        hopper.next_channel = lambda: plans[dwells["n"] % 2]  # type: ignore[method-assign]

        stats = capture.run_capture(
            iface="wlan-test",
            hopper=hopper,
            pipeline=pipeline,
            publisher=pub,
            heartbeat_s=0.0,
            should_run=lambda: dwells["n"] < 12,
            socket_factory=lambda _iface: FakeRadio([]),
        )
        assert stats.channel_errors >= 3, "some hops should have failed"
        assert stats.dwells >= 12, "but the capture must keep going"


class TestChannelPlanPruning:
    """channels.yaml keeps channels that are legal in other regdomains (12 and
    13), so what this adapter may tune to is a runtime question. Unpruned,
    every visit to a forbidden channel failed the hop and burned a dwell on
    the previous channel -- 4,247 warnings in 24 h on a US regdomain -- and a
    five-in-a-row draw of forbidden channels aborted a healthy capture."""

    # The shape `iw phy phy0 channels` really prints. "(disabled)" appears on
    # the channel line itself; "No IR" and radar notes are indented under it,
    # and no-IR only restricts transmitting, which this sensor never does.
    PHY_CHANNELS = """\
Band 1:
        * 2412 MHz [1]
          Maximum TX power: 30.0 dBm
          Channel widths: 20MHz HT40+
        * 2437 MHz [6]
          Maximum TX power: 30.0 dBm
        * 2462 MHz [11]
          Maximum TX power: 30.0 dBm
        * 2467 MHz [12] (disabled)
        * 2472 MHz [13] (disabled)
Band 2:
        * 5180 MHz [36]
          Maximum TX power: 23.0 dBm
        * 5260 MHz [52]
          No IR
          Radar detection
        * 5745 MHz [149]
          Maximum TX power: 30.0 dBm
"""

    def test_disabled_channels_are_dropped_and_no_ir_kept(self):
        permitted = capture.parse_phy_channels(self.PHY_CHANNELS)
        assert permitted == {1, 6, 11, 36, 52, 149}

    def test_forbidden_channels_leave_the_plan(self, monkeypatch):
        monkeypatch.setattr(capture, "permitted_channels", lambda iface: {1, 6, 11})
        plan = [
            ChannelSpec(channel=6, freq_mhz=2437, weight=40.0),
            ChannelSpec(channel=12, freq_mhz=2467, weight=1.05),
            ChannelSpec(channel=13, freq_mhz=2472, weight=1.05),
        ]
        pruned = capture.prune_channel_plan(plan, "wlan-test")
        assert [spec.channel for spec in pruned] == [6]

    def test_an_unreadable_regdomain_keeps_the_plan(self, monkeypatch):
        # No `iw`, no phy: hopping and occasionally failing beats not starting.
        monkeypatch.setattr(capture, "permitted_channels", lambda iface: None)
        plan = [ChannelSpec(channel=12, freq_mhz=2467, weight=1.0)]
        assert capture.prune_channel_plan(plan, "wlan-test") == plan

    def test_a_plan_with_no_usable_channel_fails_loudly(self, monkeypatch):
        monkeypatch.setattr(capture, "permitted_channels", lambda iface: {36})
        plan = [ChannelSpec(channel=12, freq_mhz=2467, weight=1.0)]
        with pytest.raises(capture.CaptureError, match="regdomain"):
            capture.prune_channel_plan(plan, "wlan-test")


class TestWatchdog:
    """The wedge this guards against: process alive, adapter present, interface
    still in monitor mode, and no heartbeat for minutes because a read is stuck
    in uninterruptible sleep on a USB transport that went away."""

    def test_fires_when_heartbeats_stop(self):
        from classg_wifi import capture

        wedged: list[int] = []
        beat = capture._Heartbeat()
        stop = capture._start_watchdog(
            beat, timeout_s=0.15, iface="wlan0", on_wedged=wedged.append
        )
        try:
            # Never call beat.mark(): this is the wedged loop.
            deadline = time.monotonic() + 3.0
            while not wedged and time.monotonic() < deadline:
                time.sleep(0.02)
        finally:
            stop()

        assert wedged == [1], "a loop that stopped heartbeating must exit"

    def test_stays_quiet_while_heartbeats_continue(self):
        from classg_wifi import capture

        wedged: list[int] = []
        beat = capture._Heartbeat()
        stop = capture._start_watchdog(
            beat, timeout_s=0.3, iface="wlan0", on_wedged=wedged.append
        )
        try:
            # A quiet sky still heartbeats. Killing here would turn "no drones"
            # into "no sensor", which is the opposite of the point.
            for _ in range(15):
                time.sleep(0.05)
                beat.mark()
        finally:
            stop()

        assert wedged == [], "a heartbeating sensor must not be killed"

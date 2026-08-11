"""Live capture loop tests, against a fake radio.

The loop is the piece that makes this a detector rather than a PCAP analyser,
and it is the hardest thing to test on hardware -- it needs a monitor-mode
adapter, root, and a drone in the air. Injecting the socket lets the parts that
actually go wrong be tested here: dwell timing, escalation, heartbeats while
idle, and what happens when the radio disappears.
"""

from __future__ import annotations

import struct
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
        monkeypatch.setattr(capture, "set_channel", lambda iface, ch: False)
        stats, _, _, _ = run_once(FakeRadio([drone_frame()]))
        assert stats.channel_errors == 1
        assert stats.dwells == 1, "the loop must keep going"

    def test_malformed_frames_do_not_stop_the_loop(self):
        radio = FakeRadio([b"\x00\x01\x02", struct.pack("<I", 0xDEADBEEF), drone_frame()])
        stats, pub, _, _ = run_once(radio)
        assert stats.frames == 3
        assert any(d["detection_class"] == "A" for d in pub.published)


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

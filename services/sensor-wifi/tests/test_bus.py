"""The wire layer: what actually reaches the bus, and what happens when it cannot.

bus.py sat at 36% coverage -- the lowest in the package, on the module that puts
every detection and every heartbeat on the wire.
"""

from __future__ import annotations

import json

import pytest
import zmq

from classg_wifi.bus import DetectionPublisher, heartbeat_message


def detection(cls: str = "A") -> dict:
    return {
        "schema_version": "1.0",
        "detection_id": "01J8XQ0000000000000000000A",
        "ts": "2026-08-11T14:23:11.482Z",
        "sensor_id": "wifi-0",
        "sensor_kind": "wifi",
        "detection_class": cls,
    }


@pytest.fixture
def pub(tmp_path):
    """A publisher on its own inproc endpoint, so tests cannot collide."""
    p = DetectionPublisher(
        endpoint=f"ipc://{tmp_path}/bus.sock", hwm=10, sensor_id="wifi-0"
    )
    yield p
    p.close()


class TestTopics:
    def test_detections_are_published_under_their_class(self, pub):
        sub = pub._ctx.socket(zmq.SUB)
        sub.setsockopt(zmq.SUBSCRIBE, b"")
        sub.connect(pub._sock.getsockopt(zmq.LAST_ENDPOINT).decode())
        # PUB drops anything sent before a subscriber attaches, so retry.
        for _ in range(200):
            pub.publish(detection("B"))
            if sub.poll(20):
                break
        topic, body = sub.recv_multipart()
        sub.close()

        assert topic == b"detection.B", "the class belongs in the topic, for filtering"
        assert json.loads(body)["detection_class"] == "B"

    def test_heartbeats_go_to_the_wifi_topic(self, pub):
        sub = pub._ctx.socket(zmq.SUB)
        sub.setsockopt(zmq.SUBSCRIBE, b"")
        sub.connect(pub._sock.getsockopt(zmq.LAST_ENDPOINT).decode())
        for _ in range(200):
            pub.heartbeat(True, {"iface": "wlan-alfa"})
            if sub.poll(20):
                break
        topic, body = sub.recv_multipart()
        sub.close()

        assert topic == b"heartbeat.wifi"
        msg = json.loads(body)
        assert msg["sensor_kind"] == "wifi"
        assert msg["detail"]["iface"] == "wlan-alfa"


class TestCounters:
    def test_published_counts_only_what_left(self, pub):
        assert pub.published == 0
        pub.publish(detection())
        pub.publish(detection())
        assert pub.published == 2
        assert pub.dropped == 0

    def test_the_heartbeat_carries_the_counters(self, pub):
        pub.publish(detection())
        msg = heartbeat_message("wifi-0", True, pub.published, pub.dropped, None)
        assert msg["published"] == 1
        assert msg["dropped"] == 0


class TestBackpressure:
    """A dropped heartbeat used to be swallowed whole.

    It is the message that distinguishes "no drones present" from "sensor
    wedged", so losing it silently produces the worse reading: the API stops
    hearing from a healthy sensor and marks it unhealthy, sending an operator
    after a radio fault that is really a slow subscriber.
    """

    def test_dropped_heartbeats_are_counted(self, pub, monkeypatch):
        def always_full(*_args, **_kwargs):
            raise zmq.Again()

        monkeypatch.setattr(pub._sock, "send_multipart", always_full)

        assert pub.heartbeats_dropped == 0
        pub.heartbeat(True, None)
        pub.heartbeat(True, None)
        assert pub.heartbeats_dropped == 2, (
            "a heartbeat that never left must be visible somewhere"
        )

    def test_a_dropped_heartbeat_does_not_raise(self, pub, monkeypatch):
        monkeypatch.setattr(
            pub._sock, "send_multipart", lambda *a, **k: (_ for _ in ()).throw(zmq.Again())
        )
        # The capture loop calls this on a timer; an exception here would take
        # down a sensor for backpressure, which is the opposite of degrading.
        pub.heartbeat(False, {"reason": "test"})

    def test_dropped_detections_are_counted(self, pub, monkeypatch):
        monkeypatch.setattr(
            pub._sock, "send_multipart", lambda *a, **k: (_ for _ in ()).throw(zmq.Again())
        )
        assert pub.publish(detection()) is False
        assert pub.dropped == 1


class TestSocketMode:
    def test_an_unknown_socket_mode_is_rejected(self, tmp_path):
        with pytest.raises(ValueError, match=r"bind.*connect"):
            DetectionPublisher(
                endpoint=f"ipc://{tmp_path}/x.sock", socket_mode="listen"
            )

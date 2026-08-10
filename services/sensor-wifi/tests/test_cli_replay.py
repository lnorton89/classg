from __future__ import annotations

from argparse import Namespace
from types import SimpleNamespace

from classg_wifi import cli


def test_replay_publishes_detections_and_heartbeat(monkeypatch) -> None:
    detection = {
        "detection_class": "A",
        "identity": {"serial": "SER1"},
        "position": None,
    }
    events: list[tuple[str, object]] = []

    class FakePipeline:
        def __init__(self, **_kwargs) -> None:
            self.stats = SimpleNamespace(
                frames_seen=1,
                beacons=1,
                class_a=1,
                class_b=0,
                class_c=0,
                parse_errors=0,
            )

        def process_frame(self, _raw: bytes):
            return [detection]

    class FakePublisher:
        def __init__(self, **_kwargs) -> None:
            events.append(("open", None))

        def publish(self, value) -> bool:
            events.append(("detection", value))
            return True

        def heartbeat(self, healthy: bool, detail=None) -> None:
            events.append(("heartbeat", (healthy, detail)))

        def close(self) -> None:
            events.append(("close", None))

    monkeypatch.setattr(cli, "Pipeline", FakePipeline)
    monkeypatch.setattr(cli, "DetectionPublisher", FakePublisher)
    monkeypatch.setattr("scapy.utils.RawPcapReader", lambda _path: [(b"frame", None)])

    args = Namespace(
        pcap="capture.pcap",
        fingerprints="missing.yaml",
        sensor_id="wifi-0",
        publish=True,
        endpoint="tcp://127.0.0.1:5556",
        zmq_hwm=1000,
        detection_topic="detection.",
        heartbeat_topic="heartbeat.",
        socket_mode="bind",
        connect_delay_s=0,
        settle_delay_s=0,
        print_detections=False,
    )

    assert cli.cmd_replay(args) == 0
    assert ("detection", detection) in events
    assert any(kind == "heartbeat" for kind, _ in events)
    assert events[-1][0] == "close"

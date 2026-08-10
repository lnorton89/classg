"""ZeroMQ PUB publisher.

Non-negotiable property: publishing must NEVER block the capture loop. Losing a
detection is recoverable; missing a beacon window while blocked on a slow consumer
is not. See ADR-0002.
"""

from __future__ import annotations

import contextlib
import json
import logging
import time
from typing import Any

import zmq

log = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "tcp://127.0.0.1:5556"
DEFAULT_HWM = 1000


class DetectionPublisher:
    def __init__(
        self,
        endpoint: str = DEFAULT_ENDPOINT,
        hwm: int = DEFAULT_HWM,
        sensor_id: str = "wifi-0",
        detection_topic: str = "detection.",
        heartbeat_topic: str = "heartbeat.",
        socket_mode: str = "bind",
    ) -> None:
        self.sensor_id = sensor_id
        self.detection_topic = detection_topic
        self.heartbeat_topic = heartbeat_topic
        self._ctx: zmq.Context[zmq.Socket[bytes]] = zmq.Context.instance()
        self._sock: zmq.Socket[bytes] = self._ctx.socket(zmq.PUB)
        self._sock.setsockopt(zmq.SNDHWM, hwm)
        # Drop immediately rather than blocking when the HWM is reached.
        self._sock.setsockopt(zmq.LINGER, 0)
        if socket_mode == "bind":
            self._sock.bind(endpoint)
        elif socket_mode == "connect":
            self._sock.connect(endpoint)
        else:
            raise ValueError("socket_mode must be 'bind' or 'connect'")
        log.info(
            "publishing detections via %s (%s, hwm=%d)", endpoint, socket_mode, hwm
        )

        self.published = 0
        self.dropped = 0

    def publish(self, detection: dict[str, Any]) -> bool:
        topic = f"{self.detection_topic}{detection['detection_class']}"
        body = json.dumps(detection, separators=(",", ":"))
        try:
            self._sock.send_multipart(
                [topic.encode(), body.encode()], flags=zmq.NOBLOCK
            )
            self.published += 1
            return True
        except zmq.Again:
            self.dropped += 1
            if self.dropped % 100 == 1:
                log.warning("bus backpressure: %d detections dropped", self.dropped)
            return False

    def heartbeat(self, healthy: bool, detail: dict[str, Any] | None = None) -> None:
        """Emit unconditionally, even when nothing was detected.

        This is what lets the system distinguish 'no drones present' from 'sensor
        wedged' - the single most important operational property (ADR-0003).
        """
        msg = {
            "schema_version": "1.0",
            "ts": time.time(),
            "sensor_id": self.sensor_id,
            "sensor_kind": "wifi",
            "healthy": healthy,
            "published": self.published,
            "dropped": self.dropped,
            "detail": detail or {},
        }
        with contextlib.suppress(zmq.Again):
            self._sock.send_multipart(
                [
                    f"{self.heartbeat_topic}wifi".encode(),
                    json.dumps(msg).encode(),
                ],
                flags=zmq.NOBLOCK,
            )

    def close(self) -> None:
        self._sock.close()

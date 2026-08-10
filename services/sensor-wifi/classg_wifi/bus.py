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
    ) -> None:
        self.sensor_id = sensor_id
        self._ctx: zmq.Context[zmq.Socket[bytes]] = zmq.Context.instance()
        self._sock: zmq.Socket[bytes] = self._ctx.socket(zmq.PUB)
        self._sock.setsockopt(zmq.SNDHWM, hwm)
        # Drop immediately rather than blocking when the HWM is reached.
        self._sock.setsockopt(zmq.LINGER, 0)
        self._sock.bind(endpoint)
        log.info("publishing detections on %s (hwm=%d)", endpoint, hwm)

        self.published = 0
        self.dropped = 0

    def publish(self, detection: dict[str, Any]) -> bool:
        topic = f"detection.{detection['detection_class']}"
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
                [b"heartbeat.wifi", json.dumps(msg).encode()], flags=zmq.NOBLOCK
            )

    def close(self) -> None:
        self._sock.close()

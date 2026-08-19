"""ZeroMQ PUB publisher.

Non-negotiable property: publishing must NEVER block the capture loop. Losing a
detection is recoverable; missing a beacon window while blocked on a slow consumer
is not. See ADR-0002.
"""

from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

import zmq

log = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "tcp://127.0.0.1:5556"
DEFAULT_HWM = 1000


def heartbeat_message(
    sensor_id: str,
    healthy: bool,
    published: int,
    dropped: int,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One heartbeat, in the shape schemas/heartbeat.schema.json pins down.

    `ts` is RFC3339 like everything else on the bus. It used to be an epoch
    float, which the SDR sensor did not copy and the API's FlexTime had to
    paper over -- exactly the cross-sensor divergence the schema now forbids.

    A module-level function rather than a method so the conformance tests can
    validate the shape without opening a socket.
    """
    return {
        "schema_version": "1.0",
        "ts": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "sensor_id": sensor_id,
        "sensor_kind": "wifi",
        "healthy": healthy,
        "published": published,
        "dropped": dropped,
        "detail": detail or {},
    }


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
        # LINGER=0 makes close() discard queued messages instead of waiting for
        # a peer to drain them, so shutdown is bounded. Not blocking when the
        # HWM is reached is NOBLOCK's job, on every send below.
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
        msg = heartbeat_message(
            self.sensor_id, healthy, self.published, self.dropped, detail
        )
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

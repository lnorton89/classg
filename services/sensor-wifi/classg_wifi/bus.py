"""ZeroMQ PUB publisher, and the one SUB that reads back.

Non-negotiable property: neither direction may EVER block the capture loop.
Losing a detection is recoverable; missing a beacon window while blocked on a
slow consumer is not. See ADR-0002.

The SUB is PeerActivity, and it is narrow on purpose. ADR-0010 lets a receiver
subscribe so it can tell whether its companion radio is busy tracking, and
nothing else: no configuration arrives this way, and a silent bus leaves the
sensor behaving exactly as it does with no subscriber at all.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

import zmq

log = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "tcp://127.0.0.1:5556"
DEFAULT_TRACK_ENDPOINT = "tcp://127.0.0.1:5557"
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
        self.heartbeats_dropped = 0

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
        try:
            self._sock.send_multipart(
                [
                    f"{self.heartbeat_topic}wifi".encode(),
                    json.dumps(msg).encode(),
                ],
                flags=zmq.NOBLOCK,
            )
        except zmq.Again:
            # Counted and logged rather than suppressed. This is the message
            # that distinguishes "no drones present" from "sensor wedged", so
            # losing it silently produces the worse of the two readings: the API
            # stops hearing from a sensor that is working perfectly well and
            # marks it unhealthy, and the operator goes looking for a radio
            # fault that is really a slow subscriber.
            #
            # Same 1-in-100 log cadence as publish(), because whatever is
            # applying backpressure is applying it to both.
            self.heartbeats_dropped += 1
            if self.heartbeats_dropped % 100 == 1:
                log.warning(
                    "bus backpressure: %d heartbeats dropped; this sensor will "
                    "read as unhealthy while it is not",
                    self.heartbeats_dropped,
                )

    def close(self) -> None:
        self._sock.close()


class PeerActivity:
    """Whether another receiver on this unit is currently hearing an aircraft.

    Reads fusion's existing track stream (ADR-0010). Tracks carry `receivers[]`
    -- which radio contributed and when -- so "is my companion busy" is already
    on the wire and needs no new message type.

    Freshness is judged two ways, because neither alone is enough:

      * The MESSAGE is recent because we just received it. Fusion publishes on
        update, so arrival is the evidence that this track is live.
      * A peer's entry is recent RELATIVE TO the newest entry on the same track.
        A track updated by wifi-0 still carries wifi-1's contribution from five
        minutes ago, and treating that as current would leave this receiver
        widened long after its companion went quiet. Comparing the two stamps
        against each other keeps the whole judgement inside fusion's own clock
        domain, so no wall clock and no cross-host skew enters into it.
    """

    def __init__(
        self,
        endpoint: str = DEFAULT_TRACK_ENDPOINT,
        sensor_id: str = "wifi-0",
        topic: str = "track.",
        active_for_s: float = 20.0,
        hwm: int = DEFAULT_HWM,
        socket_mode: str = "connect",
    ) -> None:
        self.sensor_id = sensor_id
        self.active_for_s = active_for_s
        self.messages = 0
        self.parse_errors = 0
        self._last_peer_at: float | None = None
        self._ctx: zmq.Context[zmq.Socket[bytes]] = zmq.Context.instance()
        self._sock: zmq.Socket[bytes] = self._ctx.socket(zmq.SUB)
        # A capture loop that falls behind must drop coordination hints, not
        # queue them: a stale hint is worse than none, and unbounded queueing is
        # how a SUB socket starts costing memory on a Pi.
        self._sock.setsockopt(zmq.RCVHWM, hwm)
        self._sock.setsockopt(zmq.LINGER, 0)
        self._sock.setsockopt(zmq.SUBSCRIBE, topic.encode())
        if socket_mode == "bind":
            self._sock.bind(endpoint)
        elif socket_mode == "connect":
            # connect, not bind: fusion Listen()s the track endpoint, and a
            # connecting SUB tolerates fusion being absent or restarting
            # without the sensor noticing.
            self._sock.connect(endpoint)
        else:
            raise ValueError("socket_mode must be 'bind' or 'connect'")
        log.info(
            "watching %s for peer activity (topic %r, active for %.0fs)",
            endpoint,
            topic,
            active_for_s,
        )

    def poll(self, now: float) -> None:
        """Drain whatever has arrived. Never blocks, never raises."""
        while True:
            try:
                parts = self._sock.recv_multipart(flags=zmq.NOBLOCK)
            except zmq.Again:
                return
            except zmq.ZMQError as exc:
                # A dead socket must not take the radio with it. Coordination
                # degrades to "no peers seen", which is the configured split
                # plan -- exactly the behaviour with no subscription at all.
                log.debug("peer socket: %s", exc)
                return
            self.messages += 1
            if self._names_an_active_peer(parts[-1] if parts else b""):
                self._last_peer_at = now

    def _names_an_active_peer(self, body: bytes) -> bool:
        try:
            track = json.loads(body)
            receivers = track.get("receivers") or []
        except (ValueError, AttributeError):
            self.parse_errors += 1
            return False
        newest: str | None = None
        for entry in receivers:
            if isinstance(entry, dict) and isinstance(entry.get("last_seen"), str):
                stamp = entry["last_seen"]
                if newest is None or stamp > newest:
                    newest = stamp
        if newest is None:
            # Tracks published before receivers existed, and any track whose
            # contributors carry no timestamp. Says nothing either way.
            return False
        for entry in receivers:
            if not isinstance(entry, dict):
                continue
            if entry.get("sensor_id") in (None, self.sensor_id):
                continue
            if _within(entry.get("last_seen"), newest, self.active_for_s):
                return True
        return False

    def peers_active(self, now: float) -> bool:
        if self._last_peer_at is None:
            return False
        return (now - self._last_peer_at) <= self.active_for_s

    def detail(self, now: float) -> dict[str, Any]:
        return {
            "peer_tracks_seen": self.messages,
            "peers_active": self.peers_active(now),
        }

    def close(self) -> None:
        self._sock.close()


def _within(stamp: object, newest: str, window_s: float) -> bool:
    """Is `stamp` within `window_s` of `newest`, both RFC3339 from one clock?

    A lexical compare is not enough -- these are two instants that need
    subtracting -- but a parse failure must not be fatal, because this is a
    tuning hint and the sensor has a radio to run.
    """
    if not isinstance(stamp, str):
        return False
    try:
        a = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        b = datetime.fromisoformat(newest.replace("Z", "+00:00"))
    except ValueError:
        return False
    return abs((b - a).total_seconds()) <= window_s

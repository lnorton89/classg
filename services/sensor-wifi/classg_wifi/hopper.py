"""Weighted, adaptive channel hopper.

The core tuning problem in this project. Remote ID beacons arrive at ~1 Hz, so a
uniform hop across 13 channels at 250 ms dwell gives a 3.25 s revisit and misses
most beacons. See docs/architecture/overview.md#channel-strategy.

Two mechanisms:

1. Weighted dwell - time allocated per channel in proportion to the prior
   probability of Remote ID appearing there (ch 6 dominates).
2. Adaptive escalation - on a drone detection, lock to that channel for a hold
   period. Keeping an existing track continuous beats discovering a second one.

Everything here is instrumented, because dwell tuning is an experiment with a
measurable objective and no published prior art to copy.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)


@dataclass(slots=True)
class ChannelSpec:
    channel: int
    freq_mhz: int
    weight: float


@dataclass
class HopperStats:
    dwells: dict[int, int] = field(default_factory=dict)
    dwell_ms: dict[int, float] = field(default_factory=dict)
    beacons: dict[int, int] = field(default_factory=dict)
    drone_hits: dict[int, int] = field(default_factory=dict)
    escalations: int = 0

    def dwell_share(self) -> dict[int, float]:
        total = sum(self.dwell_ms.values())
        if total <= 0:
            return {}
        return {ch: ms / total for ch, ms in self.dwell_ms.items()}


class ChannelHopper:
    """Selects the next channel and dwell time. Does not touch hardware itself -
    the caller owns the radio, which keeps this class trivially unit-testable."""

    def __init__(
        self,
        channels: list[ChannelSpec],
        base_dwell_ms: int = 400,
        hop_latency_ms: int = 140,
        escalation_hold_s: float = 30.0,
        rng: random.Random | None = None,
    ) -> None:
        if not channels:
            raise ValueError("hopper needs at least one channel")

        self.channels = channels
        self.base_dwell_ms = base_dwell_ms
        # Measured mt7921u hop latency is ~140 ms - a large fraction of a 1 s
        # beacon interval. Dwell budget must account for it or the effective
        # listening time is far lower than configured.
        self.hop_latency_ms = hop_latency_ms
        self.escalation_hold_s = escalation_hold_s
        self._rng = rng or random.Random()

        self.stats = HopperStats()
        self._locked_channel: int | None = None
        self._lock_expires_at: float = 0.0
        self._current: ChannelSpec = channels[0]

        total = sum(c.weight for c in channels)
        if total <= 0:
            raise ValueError("channel weights must sum to > 0")
        self._cumulative: list[tuple[float, ChannelSpec]] = []
        acc = 0.0
        for spec in channels:
            acc += spec.weight / total
            self._cumulative.append((acc, spec))

    @property
    def current(self) -> ChannelSpec:
        return self._current

    @property
    def is_escalated(self) -> bool:
        return self._locked_channel is not None and time.monotonic() < self._lock_expires_at

    def on_drone_detected(self, channel: int) -> None:
        """Lock dwell to `channel`. Called by the capture loop on any Class A/B hit."""
        self.stats.drone_hits[channel] = self.stats.drone_hits.get(channel, 0) + 1
        was_escalated = self.is_escalated
        self._locked_channel = channel
        self._lock_expires_at = time.monotonic() + self.escalation_hold_s
        if not was_escalated:
            self.stats.escalations += 1
            log.info("escalating: locking dwell to channel %d for %.0fs",
                     channel, self.escalation_hold_s)

    def on_beacon(self, channel: int) -> None:
        self.stats.beacons[channel] = self.stats.beacons.get(channel, 0) + 1

    def next_channel(self) -> ChannelSpec:
        if self.is_escalated:
            for spec in self.channels:
                if spec.channel == self._locked_channel:
                    self._current = spec
                    return spec
            # Locked to a channel we don't know about; drop the lock.
            self._locked_channel = None

        r = self._rng.random()
        for threshold, spec in self._cumulative:
            if r <= threshold:
                self._current = spec
                return spec
        self._current = self.channels[-1]
        return self._current

    def dwell_ms(self) -> int:
        """Listening time on the current channel, excluding hop latency."""
        if self.is_escalated:
            return self.base_dwell_ms * 3
        return self.base_dwell_ms

    def record_dwell(self, channel: int, actual_ms: float) -> None:
        self.stats.dwells[channel] = self.stats.dwells.get(channel, 0) + 1
        self.stats.dwell_ms[channel] = self.stats.dwell_ms.get(channel, 0.0) + actual_ms

    def efficiency_report(self) -> dict[str, object]:
        """Metrics for tuning. `listening_fraction` is the headline number: the
        share of wall-clock actually spent receiving rather than retuning."""
        total_dwell = sum(self.stats.dwell_ms.values())
        total_hops = sum(self.stats.dwells.values())
        overhead = total_hops * self.hop_latency_ms
        wall = total_dwell + overhead
        return {
            "listening_fraction": (total_dwell / wall) if wall else 0.0,
            "hops": total_hops,
            "hop_overhead_ms": overhead,
            "dwell_share": self.stats.dwell_share(),
            "beacons_per_channel": dict(self.stats.beacons),
            "drone_hits_per_channel": dict(self.stats.drone_hits),
            "escalations": self.stats.escalations,
            "currently_escalated": self.is_escalated,
        }


def load_channels(config: dict[str, Any]) -> list[ChannelSpec]:
    """Build the channel plan from config/channels.yaml."""
    specs: list[ChannelSpec] = []
    for entry in config.get("channels", []):
        specs.append(
            ChannelSpec(
                channel=int(entry["channel"]),
                freq_mhz=int(entry["freq_mhz"]),
                weight=float(entry.get("weight", 1.0)),
            )
        )
    return specs

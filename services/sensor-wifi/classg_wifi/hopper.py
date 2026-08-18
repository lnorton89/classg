"""Weighted, adaptive channel hopper.

The core tuning problem in this project. Remote ID beacons arrive at ~1 Hz, so a
uniform hop across 13 channels at 250 ms dwell gives a 3.25 s revisit and misses
most beacons. See docs/architecture/overview.md#channel-strategy.

Two mechanisms:

1. Weighted dwell - time allocated per channel in proportion to the prior
   probability of Remote ID appearing there (ch 6 dominates).
2. Adaptive escalation - on a drone detection, lock to that channel for a hold
   period. Keeping an existing track continuous beats discovering a second one.
   The lock reserves every Nth dwell for the normal sweep, because "beats" is a
   trade and not a reason to stop looking entirely - see `escalation_scan_every`.

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
    scan_dwells: int = 0

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
        escalation_scan_every: int = 4,
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
        # One dwell in N is handed back to the weighted sweep while locked, and
        # excludes the locked channel so the slot is actually spent looking
        # elsewhere. Below 2 the reservation is disabled, which restores the
        # original lock-everything behaviour for A/B tuning.
        #
        # Escalation used to be absolute. On 2026-08-17 a drone held the lock on
        # ch6 for 2m45s of continuous Class A hits, and the radio did not visit
        # any other channel for the whole flight: a 5.8 GHz emitter that had been
        # sampled twice before takeoff was never seen again, and a second
        # aircraft anywhere else would have been invisible for the duration.
        # At the default 3x escalated dwell that costs ~9% of listening time.
        self.escalation_scan_every = escalation_scan_every
        self._rng = rng or random.Random()

        self.stats = HopperStats()
        self._locked_channel: int | None = None
        self._lock_expires_at: float = 0.0
        self._dwells_since_scan = 0
        self._scanning = False
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
            self._dwells_since_scan = 0
            log.info("escalating: locking dwell to channel %d for %.0fs",
                     channel, self.escalation_hold_s)

    def on_beacon(self, channel: int, count: int = 1) -> None:
        """Record beacons heard on a channel.

        `count` exists because the capture loop learns the number for a whole
        dwell at once, from the pipeline's running total, rather than one frame
        at a time.
        """
        if count <= 0:
            return
        self.stats.beacons[channel] = self.stats.beacons.get(channel, 0) + count

    def _claim_scan_slot(self) -> bool:
        """Advance the escalated-dwell counter, reporting whether this dwell is
        the reserved sweep slot."""
        if self.escalation_scan_every < 2:
            return False
        self._dwells_since_scan += 1
        if self._dwells_since_scan >= self.escalation_scan_every:
            self._dwells_since_scan = 0
            return True
        return False

    def _pick_excluding(self, exclude: int | None) -> ChannelSpec:
        """Weighted pick over everything but `exclude`.

        The exclusion is what makes the reservation worth its cost: ch6 carries
        40% of the weight, so a scan slot drawn from the full plan would land
        back on the locked channel far too often to be a sweep.
        """
        pool = [c for c in self.channels if c.channel != exclude]
        if not pool:
            return self.channels[0]
        total = sum(c.weight for c in pool)
        if total <= 0:
            return pool[0]
        r = self._rng.random() * total
        acc = 0.0
        for spec in pool:
            acc += spec.weight
            if r <= acc:
                return spec
        return pool[-1]

    def next_channel(self) -> ChannelSpec:
        if self.is_escalated:
            if self._claim_scan_slot():
                self.stats.scan_dwells += 1
                self._scanning = True
                self._current = self._pick_excluding(self._locked_channel)
                return self._current
            for spec in self.channels:
                if spec.channel == self._locked_channel:
                    self._scanning = False
                    self._current = spec
                    return spec
            # Locked to a channel we don't know about; drop the lock.
            self._locked_channel = None

        self._scanning = False
        r = self._rng.random()
        for threshold, spec in self._cumulative:
            if r <= threshold:
                self._current = spec
                return spec
        self._current = self.channels[-1]
        return self._current

    def dwell_ms(self) -> int:
        """Listening time on the current channel, excluding hop latency."""
        # A reserved scan slot is a sweep dwell wherever it lands. Giving it the
        # escalated 3x would spend triple the time off the tracked channel for
        # no gain -- the point is to sample elsewhere, not to camp there.
        if self._scanning:
            return self.base_dwell_ms
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
            "scan_dwells": self.stats.scan_dwells,
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

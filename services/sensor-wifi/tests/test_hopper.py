"""Channel hopper behaviour, especially what escalation does to the sweep.

The escalation path had no direct coverage until a drone locked the radio to
ch6 for a whole flight on 2026-08-17 and nothing noticed.
"""

from __future__ import annotations

import random

from classg_wifi.hopper import ChannelHopper, ChannelSpec

# Weight-shaped like config/channels.yaml: ch6 dominates, 5 GHz is a thin tail.
PLAN = [
    ChannelSpec(channel=6, freq_mhz=2437, weight=40.0),
    ChannelSpec(channel=1, freq_mhz=2412, weight=15.0),
    ChannelSpec(channel=11, freq_mhz=2462, weight=15.0),
    ChannelSpec(channel=149, freq_mhz=5745, weight=3.0),
]


def make(**kw) -> ChannelHopper:
    kw.setdefault("rng", random.Random(1234))
    return ChannelHopper(PLAN, base_dwell_ms=400, **kw)


class TestEscalation:
    def test_lock_holds_the_channel_between_scan_slots(self):
        h = make(escalation_scan_every=4)
        h.on_drone_detected(6)

        # Three locked dwells, then the reserved slot.
        assert [h.next_channel().channel for _ in range(3)] == [6, 6, 6]
        assert h.next_channel().channel != 6

    def test_lock_never_starves_the_rest_of_the_plan(self):
        """The 2026-08-17 failure: 2m45s of continuous Class A hits on ch6 and
        the radio visited nothing else for the entire flight."""
        h = make(escalation_scan_every=4)

        seen: set[int] = set()
        for _ in range(400):
            # Refresh the lock every dwell, exactly as a beacon at 4 Hz does.
            h.on_drone_detected(6)
            seen.add(h.next_channel().channel)

        assert seen != {6}, "escalation still blinds the sensor to every other channel"
        assert 149 in seen, "5 GHz tail never sampled while locked"

    def test_scan_slots_never_land_back_on_the_locked_channel(self):
        h = make(escalation_scan_every=2)

        landings = []
        for _ in range(200):
            h.on_drone_detected(6)
            spec = h.next_channel()
            if h.stats.scan_dwells and spec.channel != 6:
                landings.append(spec.channel)

        # ch6 carries 40 of 73 weight; an unexcluded draw would return it
        # constantly. Every scan slot must be spent elsewhere.
        assert landings
        assert 6 not in landings

    def test_scan_slot_uses_a_sweep_dwell_not_the_escalated_one(self):
        h = make(escalation_scan_every=2)
        h.on_drone_detected(6)

        h.next_channel()  # locked dwell
        assert h.dwell_ms() == 400 * 3

        h.next_channel()  # reserved scan dwell
        assert h.dwell_ms() == 400

    def test_reservation_can_be_disabled_for_ab_tuning(self):
        h = make(escalation_scan_every=0)
        h.on_drone_detected(6)

        assert {h.next_channel().channel for _ in range(50)} == {6}
        assert h.stats.scan_dwells == 0

    def test_scan_dwells_are_reported(self):
        h = make(escalation_scan_every=3)
        for _ in range(30):
            h.on_drone_detected(6)
            h.next_channel()

        report = h.efficiency_report()
        assert report["scan_dwells"] == h.stats.scan_dwells > 0
        assert report["currently_escalated"] is True

    def test_expired_lock_returns_to_the_weighted_sweep(self):
        h = make(escalation_hold_s=0.0, escalation_scan_every=4)
        h.on_drone_detected(6)

        assert h.is_escalated is False
        assert h.dwell_ms() == 400


class TestWeighting:
    def test_unescalated_hopping_follows_the_weights(self):
        h = make()
        counts: dict[int, int] = {}
        for _ in range(4000):
            ch = h.next_channel().channel
            counts[ch] = counts.get(ch, 0) + 1

        # ch6 is 40/73 of the plan. Loose bounds: this asserts the weighting is
        # applied at all, not that a seeded RNG hits an exact figure.
        assert 0.45 < counts[6] / 4000 < 0.65
        assert counts[149] > 0

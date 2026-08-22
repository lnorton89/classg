"""One receiver widening while the other is busy tracking (ADR-0010).

The problem: when either radio detects a drone the hopper locks to that channel
for escalation_hold_s, renewed on every further detection, handing back only one
dwell in escalation_scan_every. On the companion receiver that collapses a
16-channel sweep to roughly one channel plus a 25% sample -- while the primary,
which has spare capacity, carries on sampling three channels the aircraft
demonstrably is not on.

The rule these tests pin is deliberately narrow. Widening is an optimisation on
top of a detector that already works, so every failure -- no fusion, no peers,
an older fusion publishing tracks without receivers, a corrupt message -- has to
land on the plan chosen at startup and nothing worse.
"""

from __future__ import annotations

import json

from classg_wifi.bus import PeerActivity
from classg_wifi.capture import PlanChoice, PlanState
from classg_wifi.hopper import ChannelHopper, ChannelSpec

SPLIT = [
    ChannelSpec(channel=6, freq_mhz=2437, weight=10.0),
    ChannelSpec(channel=1, freq_mhz=2412, weight=1.0),
    ChannelSpec(channel=11, freq_mhz=2462, weight=1.0),
]
SOLO = [
    *SPLIT,
    ChannelSpec(channel=36, freq_mhz=5180, weight=3.0),
    ChannelSpec(channel=44, freq_mhz=5220, weight=3.0),
    ChannelSpec(channel=149, freq_mhz=5745, weight=3.0),
]


def hopper(channels=SPLIT) -> ChannelHopper:
    return ChannelHopper(list(channels), base_dwell_ms=400)


def state(**kw) -> PlanState:
    kw.setdefault(
        "choice", PlanChoice(path="channels-primary.yaml", solo_path="channels.yaml")
    )
    kw.setdefault("split", SPLIT)
    kw.setdefault("solo", SOLO)
    kw.setdefault("min_hold_s", 30.0)
    return PlanState(**kw)


def channels_of(h: ChannelHopper) -> set[int]:
    return {c.channel for c in h.channels}


class TestPlanSwap:
    def test_a_busy_peer_widens_this_receiver(self):
        h, st = hopper(), state()

        assert st.reconcile(h, peer_active=True, now=100.0) is True
        assert st.widened is True
        assert channels_of(h) == {c.channel for c in SOLO}

    def test_a_quiet_peer_narrows_it_back(self):
        h, st = hopper(), state()
        st.reconcile(h, peer_active=True, now=100.0)

        assert st.reconcile(h, peer_active=False, now=200.0) is True
        assert st.widened is False
        assert channels_of(h) == {c.channel for c in SPLIT}

    def test_swapping_keeps_the_tuning_evidence(self):
        """dwell_share and beacons_per_channel are what the weights get tuned
        from. A receiver that swapped twice during a flight must not report only
        the last fragment of its own history."""
        h, st = hopper(), state()
        h.record_dwell(6, 400.0)
        h.on_beacon(6, 12)

        st.reconcile(h, peer_active=True, now=100.0)

        assert h.stats.beacons[6] == 12
        assert h.stats.dwell_ms[6] == 400.0

    def test_this_receiver_does_not_widen_while_holding_its_own_contact(self):
        """A radio tracking an aircraft should keep tracking it. Widening
        mid-contact spends dwells elsewhere and is how you drop the one you
        already have."""
        h, st = hopper(), state()
        h.on_drone_detected(6)
        assert h.is_escalated

        assert st.reconcile(h, peer_active=True, now=100.0) is False
        assert st.widened is False
        assert channels_of(h) == {c.channel for c in SPLIT}

    def test_a_receiver_already_on_the_solo_plan_has_nothing_to_widen_to(self):
        """The companion was absent at startup, so the full plan is already
        loaded -- see resolve_channel_plan."""
        st = state(
            choice=PlanChoice(
                path="channels.yaml", fallback=True, solo_path="channels.yaml"
            )
        )
        h = hopper(SOLO)

        assert st.can_widen is False
        assert st.reconcile(h, peer_active=True, now=100.0) is False

    def test_coordination_off_leaves_the_plan_alone(self):
        """solo=None is what --no-peer-coordination produces."""
        h, st = hopper(), state(solo=None)

        assert st.can_widen is False
        assert st.reconcile(h, peer_active=True, now=100.0) is False
        assert channels_of(h) == {c.channel for c in SPLIT}


class TestHysteresis:
    def test_a_flickering_peer_does_not_thrash_the_plan(self):
        """Escalation renews its lock on every further detection, so a peer
        tracking ONE aircraft crosses the active window repeatedly. Rebuilding
        the plan each time would spend the dwell budget on retunes -- the exact
        cost this feature exists to avoid."""
        h, st = hopper(), state(min_hold_s=30.0)
        st.reconcile(h, peer_active=True, now=100.0)

        for t in (101.0, 105.0, 120.0, 129.0):
            assert st.reconcile(h, peer_active=False, now=t) is False

        assert st.widened is True
        assert st.swaps == 1

    def test_the_hold_expires_rather_than_latching(self):
        h, st = hopper(), state(min_hold_s=30.0)
        st.reconcile(h, peer_active=True, now=100.0)

        assert st.reconcile(h, peer_active=False, now=131.0) is True
        assert st.swaps == 2

    def test_no_swap_when_the_picture_has_not_changed(self):
        h, st = hopper(), state()

        assert st.reconcile(h, peer_active=False, now=100.0) is False
        assert st.swaps == 0


class TestHeartbeatDetail:
    def test_the_widened_plan_is_named_not_the_startup_one(self):
        """While widened, reporting the startup filename would be a lie, and
        the heartbeat is the only place /health or an operator can see it."""
        h, st = hopper(), state()
        st.reconcile(h, peer_active=True, now=100.0)

        detail = st.detail()
        assert detail["plan"] == "channels.yaml"
        assert detail["plan_widened_for_peer"] is True
        assert detail["plan_swaps"] == 1

    def test_the_startup_plan_is_named_when_not_widened(self):
        detail = state().detail()
        assert detail["plan"] == "channels-primary.yaml"
        assert detail["plan_widened_for_peer"] is False


class TestReadingPeerActivityOffTheTrackStream:
    """PeerActivity parses fusion's tracks. The socket is not exercised here --
    _names_an_active_peer is the whole decision, and it is pure.
    """

    def watcher(self, sensor_id: str = "wifi-0", active_for_s: float = 20.0):
        # __new__ rather than __init__: constructing one opens a ZMQ socket, and
        # what is under test is the judgement, not the transport.
        w = PeerActivity.__new__(PeerActivity)
        w.sensor_id = sensor_id
        w.active_for_s = active_for_s
        w.messages = 0
        w.parse_errors = 0
        w._last_peer_at = None
        return w

    def track(self, receivers) -> bytes:
        return json.dumps({"schema_version": "1.0", "receivers": receivers}).encode()

    def test_a_peer_contributing_now_counts_as_busy(self):
        w = self.watcher("wifi-0")
        body = self.track(
            [
                {"sensor_id": "wifi-0", "last_seen": "2026-08-21T12:00:00.000Z"},
                {"sensor_id": "wifi-1", "last_seen": "2026-08-21T12:00:02.000Z"},
            ]
        )
        assert w._names_an_active_peer(body) is True

    def test_my_own_contribution_is_not_a_peer(self):
        """Otherwise every track this radio produces would tell it to widen,
        which is precisely backwards: it is the one holding the contact."""
        w = self.watcher("wifi-0")
        body = self.track([{"sensor_id": "wifi-0", "last_seen": "2026-08-21T12:00:00.000Z"}])
        assert w._names_an_active_peer(body) is False

    def test_a_stale_peer_entry_on_a_live_track_does_not_count(self):
        """The failure this guards: a track still being updated by wifi-0 keeps
        carrying wifi-1's contribution from five minutes ago. Read as current,
        it would hold this receiver widened long after the peer went quiet."""
        w = self.watcher("wifi-0", active_for_s=20.0)
        body = self.track(
            [
                {"sensor_id": "wifi-0", "last_seen": "2026-08-21T12:05:00.000Z"},
                {"sensor_id": "wifi-1", "last_seen": "2026-08-21T12:00:00.000Z"},
            ]
        )
        assert w._names_an_active_peer(body) is False

    def test_a_track_with_no_receivers_says_nothing(self):
        """Tracks published by a fusion older than the receivers field. Absence
        of evidence must not read as evidence of a busy peer."""
        w = self.watcher()
        assert w._names_an_active_peer(self.track([])) is False
        assert w._names_an_active_peer(b'{"schema_version":"1.0"}') is False

    def test_malformed_input_is_counted_and_survived(self):
        w = self.watcher()
        assert w._names_an_active_peer(b"not json at all") is False
        assert w._names_an_active_peer(b"[1,2,3]") is False
        assert w.parse_errors == 2

    def test_an_entry_without_a_timestamp_is_ignored(self):
        w = self.watcher("wifi-0")
        body = self.track(
            [
                {"sensor_id": "wifi-1"},
                {"sensor_id": "wifi-2", "last_seen": "2026-08-21T12:00:00.000Z"},
            ]
        )
        # wifi-2 is a peer and is current, so this is True on its account, not
        # on the untimestamped wifi-1 entry.
        assert w._names_an_active_peer(body) is True

    def test_activity_expires_on_the_local_clock(self):
        w = self.watcher(active_for_s=20.0)
        w._last_peer_at = 100.0

        assert w.peers_active(115.0) is True
        assert w.peers_active(121.0) is False

    def test_nothing_heard_yet_is_not_activity(self):
        assert self.watcher().peers_active(1000.0) is False

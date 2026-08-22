"""A receiver left on its own must widen, not run half a plan.

channels-primary.yaml and channels-sweep.yaml partition the spectrum
(test_channel_plans.py asserts they do). That partition is only correct while
both radios are running. The failure this file guards is the quiet one: a unit
built with one adapter, or one whose second adapter was never plugged back in,
running a plan that was written on the assumption something else covered the
rest -- no 5 GHz at all on the primary, no channel 6 at all on the companion.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from classg_wifi.capture import PlanChoice, resolve_channel_plan

CONFIG = Path(__file__).parents[1] / "config"


def channels(name: str) -> set[int]:
    doc = yaml.safe_load((CONFIG / name).read_text(encoding="utf-8"))
    return {int(entry["channel"]) for entry in doc["channels"]}


def resolve(present: bool, **kw):
    """resolve_channel_plan against a fake kernel and a virtual clock.

    The clock has to advance when the fake sleeps, not just record the call:
    with a frozen clock the deadline is never reached and the loop spins on
    wall-time instead of the budget under test. Caught by
    test_an_absent_companion_is_waited_for_but_not_for_ever, which counted
    8.8 million 0.5 s "sleeps" inside a 2 s wait.
    """
    now = 0.0
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        nonlocal now
        slept.append(seconds)
        now += seconds

    kw.setdefault("split_path", "config/channels-primary.yaml")
    kw.setdefault("solo_path", "config/channels.yaml")
    kw.setdefault("companion_iface", "wlan-tplink")
    kw.setdefault("wait_s", 0.0)
    return (
        resolve_channel_plan(
            exists=lambda _iface: present,
            sleep=sleep,
            monotonic=lambda: now,
            **kw,
        ),
        slept,
    )


def test_companion_present_keeps_the_split_plan():
    plan, _ = resolve(present=True)

    assert plan.path == "config/channels-primary.yaml"
    assert plan.fallback is False
    assert plan.companion_present is True


def test_companion_absent_widens_to_the_full_plan():
    plan, _ = resolve(present=False)

    assert plan.path == "config/channels.yaml"
    assert plan.fallback is True
    assert plan.companion_present is False


def test_no_companion_configured_uses_the_given_plan_unconditionally():
    """`make sense` and the replay paths pass neither flag; nothing changes."""
    plan = resolve_channel_plan(split_path="config/channels.yaml")

    assert plan.path == "config/channels.yaml"
    assert plan.fallback is False
    assert plan.companion_present is None
    assert "companion_present" not in plan.detail()


def test_no_solo_plan_configured_disables_the_fallback():
    """A companion named without somewhere to fall back to must not widen to
    nothing. Loading an empty path would be a crash, not a degradation."""
    plan, _ = resolve(present=False, solo_path="")

    assert plan.path == "config/channels-primary.yaml"
    assert plan.fallback is False


def test_a_present_companion_is_not_waited_for():
    """The wait exists for the boot race with udev, not as a fixed startup cost
    on a working unit."""
    _plan, slept = resolve(present=True, wait_s=15.0)

    assert slept == []


def test_an_absent_companion_is_waited_for_but_not_for_ever():
    """The TP-Link enumerates behind a USB mode-switch, so 'not there yet' and
    'not fitted' are the same observation until the deadline passes."""
    _plan, slept = resolve(present=False, wait_s=2.0, poll_s=0.5)

    assert slept, "an absent companion must be given time to enumerate"
    assert sum(slept) <= 2.0, f"waited {sum(slept)}s past a 2s budget"


def test_the_fallback_plan_actually_closes_the_hole_it_is_for():
    """The point of the widening, stated as coverage rather than as a filename.

    Both directions matter and they fail differently: the primary alone loses
    every 5 GHz channel, and the companion alone loses channel 6 -- the one
    channel a DJI was measured on here.
    """
    solo = channels("channels.yaml")

    assert channels("channels-primary.yaml") < solo
    assert channels("channels-sweep.yaml") < solo
    assert not any(c >= 36 for c in channels("channels-primary.yaml"))
    assert 6 not in channels("channels-sweep.yaml")

    assert any(c >= 36 for c in solo), "the fallback must restore 5 GHz"
    assert 6 in solo, "the fallback must restore the measured Remote ID channel"


def test_heartbeat_detail_reports_the_choice():
    """/health cannot ask the sensor anything (ADR-0002, sensors only publish),
    so the plan has to arrive on the heartbeat or it is unknowable."""
    widened = PlanChoice(
        path="config/channels.yaml",
        fallback=True,
        companion_iface="wlan-tplink",
        companion_present=False,
    ).detail()

    assert widened == {
        "plan": "channels.yaml",
        "plan_fallback": True,
        "companion_iface": "wlan-tplink",
        "companion_present": False,
    }

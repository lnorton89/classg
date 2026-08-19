"""The dual-radio plans must partition coverage rather than silently overlap."""

from __future__ import annotations

from pathlib import Path

import yaml

CONFIG = Path(__file__).parents[1] / "config"


def channels(name: str) -> list[int]:
    doc = yaml.safe_load((CONFIG / name).read_text(encoding="utf-8"))
    return [int(entry["channel"]) for entry in doc["channels"]]


def test_primary_receiver_leads_on_the_measured_drone_channel():
    """Weighted toward 6, but not parked on it.

    Parked, the receiver produced zero frames forever and was indistinguishable
    from a dead one -- channel 6 is empty at this site. It must still visit
    channels something transmits on, or it has no proof of life.
    """
    import yaml

    doc = yaml.safe_load((CONFIG / "channels-primary.yaml").read_text(encoding="utf-8"))
    weights = {int(e["channel"]): float(e["weight"]) for e in doc["channels"]}

    assert 6 in weights, "the measured Remote ID channel must still be covered"
    assert len(weights) > 1, "a single-channel plan has no proof of life"
    assert weights[6] > sum(w for c, w in weights.items() if c != 6), (
        "channel 6 must still dominate the plan"
    )


def test_companion_plan_never_duplicates_primary_or_us_disabled_channels():
    sweep = channels("channels-sweep.yaml")

    assert len(sweep) == len(set(sweep))
    assert 6 not in sweep
    assert 12 not in sweep
    assert 13 not in sweep


def test_dual_plan_preserves_every_useful_channel_from_general_plan():
    general = set(channels("channels.yaml")) - {12, 13}
    dual = set(channels("channels-primary.yaml")) | set(channels("channels-sweep.yaml"))

    assert dual == general

"""The dual-radio plans must partition coverage rather than silently overlap."""

from __future__ import annotations

from pathlib import Path

import yaml

CONFIG = Path(__file__).parents[1] / "config"


def channels(name: str) -> list[int]:
    doc = yaml.safe_load((CONFIG / name).read_text(encoding="utf-8"))
    return [int(entry["channel"]) for entry in doc["channels"]]


def test_primary_receiver_stays_on_measured_drone_channel():
    assert channels("channels-primary.yaml") == [6]


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

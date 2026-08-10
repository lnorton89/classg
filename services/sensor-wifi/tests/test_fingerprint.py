"""Vendor fingerprint matching (detection Class C).

The weakest evidence class, and the one most able to manufacture false
positives, so its precedence rules are worth pinning down.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from classg_wifi.fingerprint import FingerprintMatcher

RULES = Path(__file__).parents[1] / "data" / "oui_fingerprints.yaml"


@pytest.fixture(scope="module")
def matcher() -> FingerprintMatcher:
    return FingerprintMatcher.from_yaml(RULES)


class TestRemoteIdSsid:
    def test_dji_serial_prefix_wins_over_generic_rid(self, matcher):
        """RID-1581... must resolve to DJI, not the generic unknown bucket.

        Both patterns match; the DJI rule is listed first so it takes priority.
        If the file is ever reordered this test is what catches it.
        """
        assert matcher.match("8c:1e:d9:fc:bb:cc", "RID-1581F9DEC259E0296040") == ("dji", "ssid")

    def test_unrecognised_manufacturer_is_not_guessed_as_dji(self, matcher):
        """A different vendor's Remote ID SSID must NOT be attributed to DJI."""
        vendor, reason = matcher.match("aa:bb:cc:dd:ee:ff", "RID-9999ABCDEFGHIJKLMNOP")
        assert vendor == "unknown_remote_id"
        assert reason == "ssid"

    def test_ordinary_access_point_is_not_a_drone(self, matcher):
        assert matcher.match("aa:bb:cc:dd:ee:ff", "HomeWiFi") is None


class TestOui:
    def test_known_dji_oui(self, matcher):
        assert matcher.match("60:60:1f:11:22:33", None) == ("dji", "oui")

    def test_randomised_mac_is_skipped(self, matcher):
        """Locally-administered bit set: the OUI carries no vendor information."""
        assert matcher.match("62:60:1f:11:22:33", None) is None

    def test_unknown_oui(self, matcher):
        assert matcher.match("00:11:22:33:44:55", None) is None

"""IEEE OUI registry loading and its effect on Class C fingerprinting.

The registry widens what Class C catches. Everything here is about making sure
it widens it in exactly one direction: more blocks belonging to vendors already
named in the rules, and nothing else.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from classg_wifi.fingerprint import FingerprintMatcher, VendorRule
from classg_wifi.oui import OUIRegistry

RULES = Path(__file__).parents[1] / "data" / "oui_fingerprints.yaml"

# Real-shaped rows: the header IEEE publishes, mixed separators, an MA-M row
# that must be skipped, and a near-miss registrant that must not be swept up.
SAMPLE_CSV = """Registry,Assignment,Organization Name,Organization Address
MA-L,60601F,"SZ DJI TECHNOLOGY CO.,LTD",Shenzhen China
MA-L,34D262,"SZ DJI TECHNOLOGY CO.,LTD",Shenzhen China
MA-L,A0BB01,"SZ DJI TECHNOLOGY CO.,LTD",Shenzhen China
MA-L,9003B7,PARROT SA,Paris France
MA-L,C0FFE1,"Autel Robotics Co., Ltd.",Shenzhen China
MA-L,C0FFE2,"Autel Intelligent Technology Corp., Ltd.",Shenzhen China
MA-L,001122,Netgear,San Jose USA
MA-M,ABCDEF0,"Some Small Registrant",Nowhere
MA-L,,Blank Assignment,Nowhere
MA-L,DDEE01,,Nowhere
"""


@pytest.fixture
def registry(tmp_path: Path) -> OUIRegistry:
    path = tmp_path / "oui.csv"
    path.write_text(SAMPLE_CSV, encoding="utf-8")
    return OUIRegistry.from_csv(path)


class TestRegistryLoading:
    def test_parses_assignments_into_colon_separated_ouis(self, registry):
        assert registry.organisation("60:60:1F:11:22:33") == "SZ DJI TECHNOLOGY CO.,LTD"
        assert registry.organisation("00:11:22:aa:bb:cc") == "Netgear"

    def test_skips_rows_that_are_not_24_bit_assignments(self, registry):
        """MA-M and MA-S blocks share leading bits between organisations.

        Truncating one to 24 bits would attribute every device in that range to
        whichever small registrant happened to be read last.
        """
        assert registry.organisation("ab:cd:ef:11:22:33") is None
        # Blank assignment and blank organisation rows carry no information.
        assert len(registry) == 7

    def test_rejects_a_file_that_is_not_the_ieee_export(self, tmp_path):
        path = tmp_path / "wrong.csv"
        path.write_text("alpha,beta\n1,2\n", encoding="utf-8")
        with pytest.raises(ValueError, match="IEEE OUI export"):
            OUIRegistry.from_csv(path)

    def test_missing_file_degrades_to_empty(self, tmp_path):
        assert len(OUIRegistry.load_if_present(tmp_path / "absent.csv")) == 0
        assert len(OUIRegistry.load_if_present(None)) == 0

    def test_malformed_file_degrades_rather_than_raising(self, tmp_path):
        """A sensor must not fail to start because a downloaded file is junk."""
        path = tmp_path / "junk.csv"
        path.write_text("not a csv at all", encoding="utf-8")
        assert len(OUIRegistry.load_if_present(path)) == 0

    def test_owner_patterns_are_case_insensitive(self, registry):
        assert registry.ouis_for("*dji*") == ["34:d2:62", "60:60:1f", "a0:bb:01"]
        assert registry.ouis_for("parrot*") == ["90:03:b7"]
        assert registry.ouis_for("*nothing here*") == []


class TestExpansion:
    def test_expands_to_blocks_the_yaml_never_listed(self, registry):
        """The point of the whole feature: A0:BB:01 is in no hand-written list."""
        matcher = FingerprintMatcher.from_yaml(RULES, registry)
        assert matcher.match("a0:bb:01:44:55:66", None) == ("dji", "oui_ieee")

    def test_hand_listed_ouis_keep_their_own_provenance(self, registry):
        """60:60:1F is in both sources; the curated entry must win the label.

        The reason string reaches the stored detection as its parser name, so a
        false positive can be traced back to the rule that produced it.
        """
        matcher = FingerprintMatcher.from_yaml(RULES, registry)
        assert matcher.match("60:60:1f:11:22:33", None) == ("dji", "oui")

    def test_specific_patterns_do_not_sweep_in_a_similarly_named_registrant(self, registry):
        """Autel Robotics makes drones. Autel Intelligent makes OBD-II scanners."""
        matcher = FingerprintMatcher.from_yaml(RULES, registry)
        assert matcher.match("c0:ff:e1:11:22:33", None) == ("autel", "oui_ieee")
        assert matcher.match("c0:ff:e2:11:22:33", None) is None

    def test_unrelated_vendors_are_still_not_drones(self, registry):
        matcher = FingerprintMatcher.from_yaml(RULES, registry)
        assert matcher.match("00:11:22:33:44:55", None) is None

    def test_randomised_macs_are_still_skipped(self, registry):
        """Expansion must not reopen the hole the LA-bit check closes."""
        matcher = FingerprintMatcher.from_yaml(RULES, registry)
        assert matcher.match("a0:bb:01:44:55:66", None) is not None
        assert matcher.match("a2:bb:01:44:55:66", None) is None

    def test_no_registry_leaves_the_curated_baseline_intact(self):
        """Absent registry is the default. It must cost nothing that was there."""
        baseline = FingerprintMatcher.from_yaml(RULES)
        assert baseline.match("60:60:1f:11:22:33", None) == ("dji", "oui")
        assert baseline.match("a0:bb:01:44:55:66", None) is None

    def test_expansion_only_ever_adds(self, registry):
        with_registry = FingerprintMatcher.from_yaml(RULES, registry)
        without = FingerprintMatcher.from_yaml(RULES)
        assert len(with_registry) > len(without)

    def test_pattern_matching_nothing_is_warned_about(self, registry, caplog):
        """Silently detecting less than configured is the failure to avoid."""
        rules = [VendorRule(vendor="ghost", ouis=[], ssid_patterns=[],
                            oui_owner_patterns=["*no such registrant*"])]
        with caplog.at_level("WARNING"):
            FingerprintMatcher(rules, registry)
        assert "matched no IEEE registrant" in caplog.text

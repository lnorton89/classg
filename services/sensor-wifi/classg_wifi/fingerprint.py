"""Wi-Fi OUI / SSID vendor fingerprinting (detection Class C).

Weakest evidence class in the system. It exists because it catches drones that
broadcast no Remote ID at all, and it costs nothing on top of frames already being
captured - but MAC randomisation and OUI reassignment make it unreliable, so fusion
caps it at 0.10 confidence.

Rules live in data/oui_fingerprints.yaml, as data rather than code, so the list can
be updated without a release. A rule may list OUIs literally, or name the IEEE
registrant to match against - see oui.py.
"""

from __future__ import annotations

import fnmatch
import logging
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .oui import OUIRegistry

log = logging.getLogger(__name__)


@dataclass(slots=True)
class VendorRule:
    vendor: str
    ouis: list[str]
    ssid_patterns: list[str]
    # fnmatch patterns against IEEE registrant names. Expanded at load against
    # the registry, if one is available; ignored entirely if not.
    oui_owner_patterns: list[str] = field(default_factory=list)


class FingerprintMatcher:
    def __init__(self, rules: list[VendorRule], registry: OUIRegistry | None = None) -> None:
        self._by_oui: dict[str, str] = {}
        self._ssid_rules: list[tuple[str, str]] = []
        # Kept apart from _by_oui so a match can say where it came from. A
        # hand-listed OUI was written down by a person; a registry one is what
        # IEEE actually assigned. Same confidence weight, different provenance,
        # and the difference lands in the stored detection's parser field.
        self._registry_ouis: dict[str, str] = {}

        for rule in rules:
            for oui in rule.ouis:
                self._by_oui[_normalise_oui(oui)] = rule.vendor
            for pattern in rule.ssid_patterns:
                self._ssid_rules.append((pattern.lower(), rule.vendor))

        if registry is not None and len(registry):
            for rule in rules:
                for pattern in rule.oui_owner_patterns:
                    matched = registry.ouis_for(pattern)
                    if not matched:
                        # A pattern that matches nothing is almost always a typo
                        # or a vendor who has since been renamed in the registry,
                        # and it fails by quietly detecting less.
                        log.warning(
                            "OUI owner pattern %r (%s) matched no IEEE registrant",
                            pattern, rule.vendor,
                        )
                        continue
                    for oui in matched:
                        if oui not in self._by_oui:
                            self._registry_ouis[oui] = rule.vendor
                    log.info(
                        "%s: %r expanded to %d IEEE-registered OUIs",
                        rule.vendor, pattern, len(matched),
                    )

    @classmethod
    def empty(cls) -> FingerprintMatcher:
        return cls([])

    @classmethod
    def from_yaml(
        cls, path: str | Path, registry: OUIRegistry | None = None
    ) -> FingerprintMatcher:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        rules = [
            VendorRule(
                vendor=entry["vendor"],
                ouis=entry.get("ouis", []),
                ssid_patterns=entry.get("ssid_patterns", []),
                oui_owner_patterns=entry.get("oui_owner_patterns", []),
            )
            for entry in data.get("vendors", [])
        ]
        log.info("loaded %d vendor fingerprint rules from %s", len(rules), path)
        return cls(rules, registry)

    def match(self, mac: str, ssid: str | None) -> tuple[str, str] | None:
        """Return (vendor, reason) or None.

        SSID is checked first: an SSID like 'Mavic-A1B2C3' is far stronger evidence
        than an OUI, which survives MAC randomisation not at all.

        `reason` distinguishes 'oui' (hand-listed in the YAML) from 'oui_ieee'
        (expanded from the IEEE registry), and it reaches the stored detection
        as the parser name, so a false positive can be traced to the rule that
        produced it.
        """
        if ssid:
            lowered = ssid.lower()
            for pattern, vendor in self._ssid_rules:
                if fnmatch.fnmatch(lowered, pattern):
                    return vendor, "ssid"

        if mac and _is_locally_administered(mac):
            # Randomised MAC - the OUI is meaningless. Bail rather than emit noise.
            return None

        oui = mac.lower()[:8]
        if oui_vendor := self._by_oui.get(oui):
            return oui_vendor, "oui"
        if registry_vendor := self._registry_ouis.get(oui):
            return registry_vendor, "oui_ieee"
        return None

    def __len__(self) -> int:
        """Total OUIs this matcher will recognise, from both sources."""
        return len(self._by_oui) + len(self._registry_ouis)


def _normalise_oui(oui: str) -> str:
    return oui.lower().replace("-", ":")


def _is_locally_administered(mac: str) -> bool:
    """Bit 1 of the first octet marks a locally administered (randomised) address."""
    try:
        return bool(int(mac.split(":")[0], 16) & 0x02)
    except (ValueError, IndexError):
        return False

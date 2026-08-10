"""Wi-Fi OUI / SSID vendor fingerprinting (detection Class C).

Weakest evidence class in the system. It exists because it catches drones that
broadcast no Remote ID at all, and it costs nothing on top of frames already being
captured - but MAC randomisation and OUI reassignment make it unreliable, so fusion
caps it at 0.10 confidence.

Rules live in data/oui_fingerprints.yaml, as data rather than code, so the list can
be updated without a release.
"""

from __future__ import annotations

import fnmatch
import logging
from dataclasses import dataclass
from pathlib import Path

import yaml

log = logging.getLogger(__name__)


@dataclass(slots=True)
class VendorRule:
    vendor: str
    ouis: list[str]
    ssid_patterns: list[str]


class FingerprintMatcher:
    def __init__(self, rules: list[VendorRule]) -> None:
        self._by_oui: dict[str, str] = {}
        self._ssid_rules: list[tuple[str, str]] = []
        for rule in rules:
            for oui in rule.ouis:
                self._by_oui[oui.lower().replace("-", ":")] = rule.vendor
            for pattern in rule.ssid_patterns:
                self._ssid_rules.append((pattern.lower(), rule.vendor))

    @classmethod
    def empty(cls) -> FingerprintMatcher:
        return cls([])

    @classmethod
    def from_yaml(cls, path: str | Path) -> FingerprintMatcher:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        rules = [
            VendorRule(
                vendor=entry["vendor"],
                ouis=entry.get("ouis", []),
                ssid_patterns=entry.get("ssid_patterns", []),
            )
            for entry in data.get("vendors", [])
        ]
        log.info("loaded %d vendor fingerprint rules from %s", len(rules), path)
        return cls(rules)

    def match(self, mac: str, ssid: str | None) -> tuple[str, str] | None:
        """Return (vendor, reason) or None.

        SSID is checked first: an SSID like 'Mavic-A1B2C3' is far stronger evidence
        than an OUI, which survives MAC randomisation not at all.
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
        vendor = self._by_oui.get(oui)
        return (vendor, "oui") if vendor else None


def _is_locally_administered(mac: str) -> bool:
    """Bit 1 of the first octet marks a locally administered (randomised) address."""
    try:
        return bool(int(mac.split(":")[0], 16) & 0x02)
    except (ValueError, IndexError):
        return False

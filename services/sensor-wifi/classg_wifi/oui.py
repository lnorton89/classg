"""IEEE MA-L registry lookup, from the published CSV.

The curated rules in data/oui_fingerprints.yaml list OUIs one at a time, by
hand, from whatever anyone happened to observe. That has two costs. Vendors hold
more MA-L blocks than anybody transcribes -- so a drone using a block nobody
wrote down is invisible to Class C -- and hand-copied entries go unverified,
which is why one DJI OUI in that file carries a comment saying it could not be
confirmed.

The registry fixes both. `oui_owner_patterns: ["*dji*"]` expands, at load, to
every block IEEE has actually assigned to DJI, and an OUI that came from the
registry is a fact about the assignment rather than somebody's note.

Offline by design. The file is a download, not a service: it changes on the
order of days, the sensor must work with no uplink, and nothing here should
make a network call while a radio is running. Refresh it with
scripts/fetch-oui-registry.sh.

None of this changes what a Class C match *means*. An OUI still identifies the
manufacturer of a radio, not an aircraft in flight, and fusion still caps it at
0.10 confidence.
"""

from __future__ import annotations

import csv
import fnmatch
import logging
from pathlib import Path

log = logging.getLogger(__name__)

# The registry publishes MA-L (24-bit), MA-M (28-bit) and MA-S (36-bit) blocks in
# separate files. Only MA-L maps cleanly onto an OUI: in an MA-M or MA-S file
# many organisations share the same leading 24 bits, so folding them in would
# attribute one company's devices to another. oui.csv is MA-L only, and any row
# whose assignment is not exactly 24 bits is skipped rather than truncated.
_OUI_HEX_LEN = 6


class OUIRegistry:
    """Maps an OUI to the organisation IEEE assigned it to."""

    def __init__(self, assignments: dict[str, str] | None = None) -> None:
        self._by_oui: dict[str, str] = dict(assignments or {})

    @classmethod
    def empty(cls) -> OUIRegistry:
        return cls()

    @classmethod
    def from_csv(cls, path: str | Path) -> OUIRegistry:
        """Load standards-oui.ieee.org/oui/oui.csv.

        Columns are read by name. IEEE has changed their order before, and a
        positional reader would map addresses to the wrong organisation while
        continuing to look like it worked.
        """
        assignments: dict[str, str] = {}
        with Path(path).open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fields = {(name or "").strip().lower(): name for name in reader.fieldnames or []}
            assignment_col = fields.get("assignment")
            org_col = fields.get("organization name") or fields.get("organization_name")
            if not assignment_col or not org_col:
                raise ValueError(
                    f"{path} has no Assignment/Organization Name columns; "
                    "this does not look like the IEEE OUI export"
                )
            for row in reader:
                raw = (row.get(assignment_col) or "").strip().replace("-", "").replace(":", "")
                if len(raw) != _OUI_HEX_LEN:
                    continue
                organisation = (row.get(org_col) or "").strip()
                if not organisation:
                    continue
                oui = ":".join(raw[i : i + 2] for i in range(0, _OUI_HEX_LEN, 2)).lower()
                assignments[oui] = organisation

        log.info("loaded %d IEEE OUI assignments from %s", len(assignments), path)
        return cls(assignments)

    @classmethod
    def load_if_present(cls, path: str | Path | None) -> OUIRegistry:
        """Load if the file is there, otherwise return an empty registry.

        Absent is the normal state: the export is ~1 MB of third-party data and
        is deliberately not committed. A sensor without it keeps the hand-listed
        OUIs and loses only the expansion, so this degrades rather than fails --
        but it says so, because silently matching fewer drones than the operator
        configured for is the failure this whole file exists to prevent.
        """
        if not path:
            return cls.empty()
        candidate = Path(path)
        if not candidate.exists():
            log.info(
                "no IEEE OUI registry at %s; vendor OUI patterns will not expand "
                "(run scripts/fetch-oui-registry.sh)",
                candidate,
            )
            return cls.empty()
        try:
            return cls.from_csv(candidate)
        except (OSError, ValueError, csv.Error) as exc:
            log.warning("could not read the IEEE OUI registry at %s: %s", candidate, exc)
            return cls.empty()

    def organisation(self, mac: str) -> str | None:
        """Return the registered organisation for a MAC, or None."""
        return self._by_oui.get(mac.lower().replace("-", ":")[:8])

    def ouis_for(self, pattern: str) -> list[str]:
        """Every OUI whose organisation name matches an fnmatch pattern.

        Case-insensitive. Patterns should be as specific as the vendor name
        allows: "*autel*" also matches Autel Intelligent Technology, who make
        car diagnostic tools, and every one of their blocks would become a
        false Class C hit.
        """
        lowered = pattern.lower()
        return sorted(
            oui
            for oui, organisation in self._by_oui.items()
            if fnmatch.fnmatch(organisation.lower(), lowered)
        )

    def __len__(self) -> int:
        return len(self._by_oui)

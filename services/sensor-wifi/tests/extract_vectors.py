"""Extract Remote ID vendor IEs from a capture into committed test vectors.

Run once per new aircraft or firmware:

    python -m tests.extract_vectors captures/<file>.pcap tests/vectors/<name>.json

Synthetic frames prove the parser handles the cases we thought of. Real bytes
prove it handles the ones we did not -- and they are the regression net that
catches a parser change quietly altering decode counts on known-good data.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

from classg_wifi.parsers import dji, odid
from classg_wifi.parsers.dot11 import parse_beacon


def extract(pcap: str, limit: int = 16) -> dict:
    """Sample vectors evenly across the WHOLE capture.

    Taking the first N is a trap: the opening beacons are all from before the
    controller has a GPS fix, so they share one state and miss everything the
    aircraft does later. Spreading the sample captures the pre-fix beacons, the
    fixed ones, and whatever happens in between.
    """
    from scapy.utils import RawPcapReader

    found: list[dict] = []
    seen: set[bytes] = set()

    for index, (raw, _meta) in enumerate(RawPcapReader(pcap)):
        beacon = parse_beacon(bytes(raw))
        if beacon is None:
            continue
        for ie in beacon.vendor_ies():
            if ie in seen:
                continue
            if ie[0:3] == odid.ODID_OUI:
                kind = "odid"
            elif ie[0:3] == dji.DJI_OUI:
                kind = "dji"
            else:
                continue
            seen.add(ie)
            found.append({
                "kind": kind,
                "frame_index": index,
                "ssid": beacon.ssid,
                "mac": beacon.transmitter,
                "freq_mhz": beacon.freq_mhz,
                "ie_b64": base64.b64encode(ie).decode("ascii"),
            })

    if len(found) > limit:
        step = len(found) / limit
        found = [found[int(i * step)] for i in range(limit)]

    return {"source": Path(pcap).name, "unique_ies": len(seen), "vectors": found}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    data = extract(argv[1])
    out = Path(argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2) + "\n")
    print(f"wrote {len(data['vectors'])} vectors to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""Check the hand-copied constants that four services keep private copies of.

Some values cannot be shared. fusion and api are separate Go modules, the API
cannot read sensor-wifi's YAML without a cross-service path that only resolves
in a source checkout, and the UI cannot import Go at all. Each of those choices
is deliberate and written down where the copy lives.

What none of them come with is a check. A copy with a comment saying "mirrors
X" is still a second implementation, and this project has already paid for that
shape: two stores disagreeing about what a zero limit meant let a password
change leave stolen sessions alive, and a validator with no test let a
backslash walk through an open redirect. The copies below all agree today. This
is what keeps them agreeing.

Deliberate divergences are not errors -- they are recorded here as expectations
with their reasoning, so that reconciling one by accident fails too.

    ./scripts/check-mirrors.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_field_names import go_vs_ts, shell_vs_go  # noqa: E402

errors: list[str] = []


def read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def fail(mirror: str, detail: str) -> None:
    errors.append(f"{mirror}: {detail}")


def compare(mirror: str, a_name: str, a, b_name: str, b) -> None:
    if a == b:
        return
    fail(mirror, f"{a_name} and {b_name} have drifted")
    only_a = sorted(set(a) - set(b), key=str)
    only_b = sorted(set(b) - set(a), key=str)
    for row in only_a:
        errors.append(f"    only in {a_name}: {row}")
    for row in only_b:
        errors.append(f"    only in {b_name}: {row}")


def check_channel_plan() -> None:
    """services/sensor-wifi/config/channels.yaml -> api defaultChannelPlan.

    The API seeds a fresh database from this. A plan that disagrees with the
    sensor's own is a settings page describing a scan that is not happening.
    """
    yaml_rows = re.findall(
        r"channel:\s*(\d+)\s*,\s*freq_mhz:\s*(\d+)\s*,\s*weight:\s*([\d.]+)",
        read("services/sensor-wifi/config/channels.yaml"),
    )
    go_rows = re.findall(
        r"\{Channel:\s*(\d+),\s*FreqMHz:\s*(\d+),\s*Weight:\s*([\d.]+)\}",
        read("services/api/internal/httpapi/configapi.go"),
    )
    if not yaml_rows or not go_rows:
        fail("channel plan", "could not parse one of the two copies; has the shape changed?")
        return

    def norm(rows):
        return [(int(c), int(f), float(w)) for c, f, w in rows]

    compare(
        "channel plan",
        "channels.yaml",
        norm(yaml_rows),
        "api defaultChannelPlan",
        norm(go_rows),
    )


def check_weights() -> None:
    """fusion DefaultWeights -> api defaultWeights.

    These are what the confidence figure on the map is built from. The API
    reporting different ones is the settings page lying about how a detection
    was scored.
    """
    fus = dict(
        re.findall(r'"([A-H])":\s*([\d.]+),', read("services/fusion/detection.go"))
    )
    api_block = re.search(
        r"func defaultWeights\(\).*?\n\}", read("services/api/internal/httpapi/configapi.go"), re.S
    )
    if not fus or not api_block:
        fail("fusion weights", "could not parse one of the two copies; has the shape changed?")
        return
    api = dict(re.findall(r'"([A-H])":\s*([\d.]+)', api_block.group(0)))
    compare(
        "fusion weights",
        "fusion DefaultWeights",
        sorted((k, float(v)) for k, v in fus.items()),
        "api defaultWeights",
        sorted((k, float(v)) for k, v in api.items()),
    )


def check_corroborating_classes() -> None:
    """fusion corroboratingOnlyClasses -> UI tier.ts CORROBORATING_ONLY.

    Classes that corroborate an identification but never make one. The UI uses
    them to split the headline list of identified aircraft from RF that merely
    looked drone-like.
    """
    go_block = re.search(
        r"var corroboratingOnlyClasses = map\[string\]bool\{(.*?)\}",
        read("services/fusion/track.go"),
        re.S,
    )
    ts_block = re.search(
        r"CORROBORATING_ONLY = new Set<string>\(\[(.*?)\]\)",
        read("services/ui/src/features/tracks/tier.ts"),
        re.S,
    )
    if not go_block or not ts_block:
        fail("corroborating classes", "could not parse a copy; has the shape changed?")
        return
    go_classes = sorted(re.findall(r'"([A-H])":\s*true', go_block.group(1)))
    ts_classes = sorted(re.findall(r"'([A-H])'", ts_block.group(1)))
    compare(
        "corroborating classes",
        "fusion corroboratingOnlyClasses",
        go_classes,
        "ui tier.ts",
        ts_classes,
    )
    # The empty-evidence case deliberately does NOT match: fusion decides
    # whether to PROMOTE a track, the UI decides whether to DISPLAY one, and
    # demoting on absence would hide a real aircraft. Pinned so that
    # reconciling it by accident fails here as well as in partition.test.ts.
    tier = read("services/ui/src/features/tracks/tier.ts")
    if "if (evidence.length === 0) return true" not in tier:
        fail(
            "corroborating classes",
            "tier.ts no longer treats absent evidence as displayable. That divergence "
            "from fusion is deliberate -- see the comment there and partition.test.ts. "
            "If it was removed on purpose, update this check with the reasoning.",
        )


def check_channel_allowlist() -> None:
    """api capture allowedChannels -> api configapi allowedChannel.

    One rejects a capture request, the other rejects a stored plan. A channel
    one accepts and the other refuses is a plan an operator can save and never
    capture on.
    """
    cap_src = read("services/api/internal/capture/capture.go")
    cfg_src = read("services/api/internal/httpapi/configapi.go")
    lists = []
    for name, src in (("capture allowedChannels", cap_src), ("configapi allowedChannel", cfg_src)):
        m = re.search(r"\[\]int\{(36,.*?)\}", src, re.S)
        if not m:
            fail("channel allowlist", f"could not parse {name}; has the shape changed?")
            return
        lists.append((name, sorted(int(n) for n in re.findall(r"\d+", m.group(1)))))
    compare("channel allowlist", lists[0][0], lists[0][1], lists[1][0], lists[1][1])


# Go response structs against the TypeScript that hand-describes them.
#
# (label, go file, go struct, ts interface). Every one of these is a shape the
# UI re-declares by hand because it cannot import Go, and every one of them has
# no compiler between the two copies. Two had already lost a field this way --
# health.Sensor's `optional` and model.Capture's `error` -- which is why the
# list is here rather than the two that were found.
GO_TS_PAIRS = [
    ("sensor health", "services/api/internal/health/health.go", "Sensor", "SensorHealth"),
    ("capture fields", "services/api/internal/model/model.go", "Capture", "Capture"),
    ("spectrum sweep", "services/api/internal/model/model.go", "SpectrumSweep", "SpectrumSweep"),
    ("hook rules", "services/api/internal/hooks/hooks.go", "Rule", "HookRule"),
    ("hook deliveries", "services/api/internal/hooks/hooks.go", "Delivery", "HookDelivery"),
    ("deployment status", "services/api/internal/deploy/deploy.go", "Status", "DeploymentStatus"),
    ("watchdog status", "services/api/internal/deploy/deploy.go", "WatchdogStatus", "WatchdogStatus"),
]

# The state documents the deploy agents write by hand, and the Go structs that
# read them. Unlike the pairs above there is no type system on either end of
# this one: a printf writing a key nobody reads, or a struct field no printf
# ever writes, is silent for ever. classg-watchdog.sh had done exactly the
# first -- publishing `wifi_tplink_adapter_present` for the second Wi-Fi
# adapter into a struct with no such field, so the panel whose entire job is
# naming missing hardware could not show half the Wi-Fi hardware.
#
# Compared against State/WatchdogState, not Status/WatchdogStatus: the outer
# types add what the API works out for itself (configured, state_age_s), which
# the script correctly never writes.
SHELL_GO_PAIRS = [
    (
        "deploy state file",
        "scripts/pi-autodeploy.sh",
        "write_state() {",
        "State",
    ),
    (
        "watchdog state file",
        "scripts/classg-watchdog.sh",
        "# --- publish ---",
        "WatchdogState",
    ),
]

DEPLOY_GO = "services/api/internal/deploy/deploy.go"


def check_go_ts_fields() -> None:
    for label, go_file, go_name, ts_name in GO_TS_PAIRS:
        go, ts, err = go_vs_ts(go_file, go_name, ts_name)
        if err:
            fail(label, err)
            continue
        compare(label, f"api {go_name}", go, f"ui {ts_name}", ts)


def check_shell_state_files() -> None:
    for label, sh_file, marker, go_name in SHELL_GO_PAIRS:
        sh, go, err = shell_vs_go(sh_file, marker, DEPLOY_GO, go_name)
        if err:
            fail(label, err)
            continue
        compare(label, sh_file, sh, f"api deploy.{go_name}", go)


def main() -> int:
    check_channel_plan()
    check_weights()
    check_corroborating_classes()
    check_channel_allowlist()
    check_go_ts_fields()
    check_shell_state_files()

    if errors:
        for e in errors:
            print(f"FAIL {e}" if not e.startswith("    ") else e)
        print()
        print("These are hand-maintained copies. Update every copy, or record the")
        print("divergence in scripts/check-mirrors.py with the reason it is correct.")
        return 1
    print("mirrors: channel plan, fusion weights, corroborating classes and the")
    print(f"channel allowlist agree; so do {len(GO_TS_PAIRS)} Go/TypeScript response shapes")
    print(f"and {len(SHELL_GO_PAIRS)} hand-written state documents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

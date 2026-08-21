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


# Four hand-rolled copies of the identifier format, in four languages.
#
# (name, file, regex capturing the alphabet)
ULID_ALPHABETS = [
    ("api internal/ulid", "services/api/internal/ulid/ulid.go",
     r'const crockford = "([^"]+)"'),
    ("fusion id.go", "services/fusion/id.go",
     r'const crockford = "([^"]+)"'),
    ("sensor-sdr ulid.rs", "services/sensor-sdr/src/ulid.rs",
     r'const CROCKFORD: &\[u8; 32\] = b"([^"]+)"'),
    ("sensor-wifi detection.py", "services/sensor-wifi/classg_wifi/detection.py",
     r'_ULID_ALPHABET = "([^"]+)"'),
]


def check_ulid_alphabet() -> None:
    """Every copy of the identifier alphabet, in every language.

    Four implementations -- two Go modules that cannot import each other, a
    Rust sensor and a Python one -- all minting ids that land in the same
    tables and the same keyset cursors. Nothing shares code, so nothing shares
    a compiler either.

    The property all four claim is that ids sort by creation time. It holds
    only while the alphabet is identical AND in ascending byte order: a copy
    that gained a character, reordered one, or moved to a different base32
    variant would still produce plausible ids, and paging over the mixed set
    would skip rows or repeat them. Which reads as a quiet sky.
    """
    found = []
    for name, rel, pattern in ULID_ALPHABETS:
        m = re.search(pattern, read(rel))
        if not m:
            fail("ulid alphabet", f"could not find the alphabet in {name} ({rel})")
            return
        found.append((name, m.group(1)))

    first_name, first = found[0]
    for name, alphabet in found[1:]:
        compare("ulid alphabet", first_name, [first], name, [alphabet])

    if len(first) != 32 or list(first) != sorted(first):
        fail(
            "ulid alphabet",
            f"{first!r} is not 32 characters in ascending byte order, so byte order "
            "no longer recovers creation order and keyset pagination is unsound",
        )


# Each copy has to refuse a timestamp before the epoch, or it emits an id
# beginning ZZZZZ that sorts after every real one -- and one such row sits at
# the end of every keyset page for good. Reachable on this hardware: a Pi has
# no RTC, so an unsynchronised clock is the ordinary first-boot state.
#
# (name, file, the expression that does the clamping)
ULID_EPOCH_CLAMPS = [
    ("api internal/ulid", "services/api/internal/ulid/ulid.go", "if milli < 0 {"),
    ("sensor-sdr ulid.rs", "services/sensor-sdr/src/ulid.rs", "epoch_ms.max(0)"),
    ("sensor-wifi detection.py", "services/sensor-wifi/classg_wifi/detection.py",
     "ts_ms = max(ts_ms, 0)"),
]


def check_ulid_epoch_clamp() -> None:
    """The pre-epoch guard, in each copy that takes a timestamp from a caller.

    fusion is absent deliberately: NewULID reads the clock itself and takes no
    argument, so there is no caller-supplied value to clamp. If it ever grows
    one, add it here.
    """
    for name, rel, needle in ULID_EPOCH_CLAMPS:
        if needle not in read(rel):
            fail(
                "ulid epoch clamp",
                f"{name} no longer clamps a pre-epoch timestamp (looked for {needle!r}). "
                "Without it a clock before 1970 mints ids beginning ZZZZZ, which sort "
                "after every real identifier.",
            )


def check_world_extract_zoom() -> None:
    """style.ts WORLD_MAX_ZOOM -> scripts/fetch-basemap.sh --maxzoom.

    The style lays a bboxless whole-world archive under a local extract, and
    declares the zoom at which to stop asking it for tiles. If the script that
    builds that archive stops at a different zoom, the map either asks for
    tiles the file does not contain or stops asking before the file runs out.
    style.ts says "Must match `--maxzoom` for the world extract in
    scripts/fetch-basemap.sh" and nothing checked that it did.
    """
    ts = re.search(
        r"export const WORLD_MAX_ZOOM = (\d+)",
        read("services/ui/src/features/map/style.ts"),
    )
    sh = re.search(
        r'"\$PMTILES" extract "\$SOURCE" "\$WORLD_OUT" --maxzoom=(\d+)',
        read("scripts/fetch-basemap.sh"),
    )
    if not ts or not sh:
        fail("world extract zoom", "could not parse a copy; has the shape changed?")
        return
    compare(
        "world extract zoom",
        "style.ts WORLD_MAX_ZOOM",
        [int(ts.group(1))],
        "fetch-basemap.sh --maxzoom",
        [int(sh.group(1))],
    )


# The tile provider, and the zoom it actually carries imagery to.
#
# Esri answers PAST its ceiling with a grey placeholder at HTTP 200 rather than
# a 404, so an over-set ceiling blanks the map instead of blurring it -- and
# nothing in the request tells you. The ceiling is therefore a property of the
# upstream, not a free choice, and the upstream is named in two files that must
# agree with each other and with the number.
KNOWN_TILE_CEILINGS = {
    # service path fragment -> the zoom it has real pixels to
    "World_Imagery": 19,
    "USGSImageryOnly": 16,
}


def check_basemap_provider() -> None:
    """nginx.conf, vite.config.ts and style.ts BASEMAP_MAX_ZOOM.

    docker/README.md calls this out as three places that must agree, and
    CLAUDE.md lists it as a repo trap. Dev and production requesting different
    upstreams also makes the tile cache built by one useless to the other,
    which is the failure the vite proxy's own comment describes.
    """
    nginx = read("services/ui/nginx.conf")
    vite = read("services/ui/vite.config.ts")
    style = read("services/ui/src/features/map/style.ts")

    def service_of(src: str) -> str | None:
        m = re.search(r"/ArcGIS/rest/services/([A-Za-z_]+)/MapServer/tile", src)
        return m.group(1) if m else None

    def host_of(src: str) -> str | None:
        m = re.search(r"https://(services\.arcgisonline\.com|basemap\.nationalmap\.gov)", src)
        return m.group(1) if m else None

    n_service, v_service = service_of(nginx), service_of(vite)
    n_host, v_host = host_of(nginx), host_of(vite)
    ceiling = re.search(r"export const BASEMAP_MAX_ZOOM = (\d+)", style)

    if not n_service or not v_service or not ceiling:
        fail("basemap provider", "could not parse a copy; has the shape changed?")
        return

    compare("basemap provider", "nginx.conf", [n_host, n_service], "vite.config.ts", [v_host, v_service])

    want = KNOWN_TILE_CEILINGS.get(n_service)
    if want is None:
        fail(
            "basemap provider",
            f"nginx proxies {n_service}, whose real zoom ceiling is not recorded in "
            "KNOWN_TILE_CEILINGS. Measure it -- request tiles directly and watch for the "
            "status flip or an identical placeholder body -- and record it here.",
        )
        return
    if int(ceiling.group(1)) != want:
        fail(
            "basemap provider",
            f"BASEMAP_MAX_ZOOM is {ceiling.group(1)} but nginx proxies {n_service}, which "
            f"carries imagery to z{want}. Set too high, this source answers past its "
            "ceiling with a placeholder at HTTP 200, so the map goes blank rather than blurry.",
        )


def check_exec_sites() -> None:
    """Every subprocess goes through internal/proc.

    Not style. exec.CommandContext's deadline kills the direct child and then
    waits for the output pipes to close, which a grandchild -- or a process
    stuck in an uninterruptible kernel wait on a wedged USB device -- keeps
    open indefinitely. Measured: a 300ms deadline held a request goroutine for
    120 seconds. internal/proc sets WaitDelay, which is the only thing that
    makes any of those timeouts real, and a direct exec anywhere else is a
    bound that the exact failure it was written for can outlast.
    """
    offenders = []
    for path in sorted((REPO / "services").rglob("*.go")):
        rel = path.relative_to(REPO).as_posix()
        if rel.endswith("_test.go") or "/internal/proc/" in rel:
            continue
        body = path.read_text(encoding="utf-8")
        for n, line in enumerate(body.splitlines(), 1):
            if "exec.CommandContext(" in line or "exec.Command(" in line:
                offenders.append(f"{rel}:{n}")
    for site in offenders:
        fail("subprocess launch", f"{site} starts a process without proc.Command")


def check_history_depth() -> None:
    """fusion's HistoryDepth vs the API's fusion.max_history.

    Both trim the same trail, in series: fusion holds a ring buffer and the API
    trims again on the way to storage. Whichever is SMALLER is the real limit,
    and only one of them is the one anybody reads. Set the API's below fusion's
    and the map quietly loses the start of a flight that fusion is still holding
    -- which is exactly what shipped, at 512 points: a real flight ran out of
    trail after 2m43s and the line began eating its own tail while recording.

    So this is not an equality check. The API's cap must simply never be the
    tighter of the two.
    """
    fusion_src = read("services/fusion/track.go")
    m = re.search(r"^	HistoryDepth\s*=\s*(\d+)", fusion_src, re.M)
    if not m:
        fail("history depth", "could not find HistoryDepth in services/fusion/track.go")
        return
    depth = int(m.group(1))

    settings_src = read("services/api/internal/settings/settings.go")
    m = re.search(
        r'Key:\s*"fusion\.max_history".*?Default:\s*"(\d+)"', settings_src, re.S
    )
    if not m:
        fail("history depth", "could not find the fusion.max_history default in settings.go")
        return
    setting = int(m.group(1))

    seed_src = read("config/defaults.yaml")
    m = re.search(r"^\s*max_history:\s*(\d+)", seed_src, re.M)
    if not m:
        fail("history depth", "could not find max_history in config/defaults.yaml")
        return
    seed = int(m.group(1))

    migrate_src = read("scripts/migrate-env.sh")
    m = re.search(r'"CLASSG_MAX_HISTORY\|fusion\.max_history\|(\d+)\|', migrate_src)
    if not m:
        fail("history depth", "could not find CLASSG_MAX_HISTORY in scripts/migrate-env.sh")
        return
    migrate = int(m.group(1))
    if migrate != setting:
        fail(
            "history depth",
            f"scripts/migrate-env.sh calls the default {migrate}, settings.go says {setting}. "
            "That table decides what counts as 'already the default', and a stale entry "
            "silently DELETES an operator's explicit setting during migration.",
        )

    if setting != seed:
        fail(
            "history depth",
            f"settings.go default ({setting}) and config/defaults.yaml ({seed}) disagree; "
            "the seed is what a fresh unit gets, so they have to match",
        )
    for name, value in (("settings.go default", setting), ("config/defaults.yaml", seed)):
        if value < depth:
            fail(
                "history depth",
                f"{name} is {value}, below fusion's HistoryDepth of {depth}. The API "
                "would trim a trail fusion still holds, and the map would lose the "
                "start of a flight that is still being recorded.",
            )


def main() -> int:
    check_channel_plan()
    check_weights()
    check_corroborating_classes()
    check_channel_allowlist()
    check_go_ts_fields()
    check_shell_state_files()
    check_exec_sites()
    check_ulid_alphabet()
    check_ulid_epoch_clamp()
    check_world_extract_zoom()
    check_basemap_provider()
    check_history_depth()

    if errors:
        for e in errors:
            print(f"FAIL {e}" if not e.startswith("    ") else e)
        print()
        print("These are hand-maintained copies. Update every copy, or record the")
        print("divergence in scripts/check-mirrors.py with the reason it is correct.")
        return 1
    print("mirrors: channel plan, fusion weights, corroborating classes and the")
    print(f"channel allowlist agree; so do {len(GO_TS_PAIRS)} Go/TypeScript response shapes")
    print(f"and {len(SHELL_GO_PAIRS)} hand-written state documents; every subprocess")
    print("goes through internal/proc, and the basemap ceiling matches its source")
    print("and the API never trims a track trail tighter than fusion keeps it")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

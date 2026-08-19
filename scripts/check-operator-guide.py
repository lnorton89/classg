#!/usr/bin/env python3
"""Check the documented commands against the things they document.

Covers docs/operator-guide.json (which powers the in-app docs page) and the
README's shell fences, because README rot is what a reader hits first: it
documented a --channel flag the CLI ignored, a PCAP that exists on one machine,
`make test` without the `make setup` that has to precede it, and Node 22 against
a manifest demanding 24. All four were found by a human reading it, which is not
a process.

The guide powers the in-app docs page, and unlike schemas/ nothing used to
check it against reality -- it once documented a --channel flag the CLI
accepted and ignored, and a PCAP that exists on exactly one machine. This
holds the checkable parts to account:

- every `path` field must name a file that exists in the repo
- every `make <target>` must be a real Makefile target
- every `scripts/...` command must be an existing file
- every `npm run <script>` must exist in services/ui/package.json
- every `classg-sensor-wifi <sub> --flag ...` must parse against the real
  CLI's --help output (requires the package importable: CI's python job, or
  the sensor venv locally)

Anything else (curl, docker, go, cargo, systemctl) is deliberately not
checked -- guessing at those would produce false failures, and the point is a
check that is trusted enough to keep running.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
import pathlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GUIDE = REPO / "docs" / "operator-guide.json"

errors: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def wifi_cli(*args: str) -> subprocess.CompletedProcess[str]:
    """Run the sensor CLI: installed entry point in CI, the venv locally."""
    candidates = [
        ["classg-sensor-wifi", *args],
        [str(REPO / "services/sensor-wifi/.venv/bin/python"), "-m", "classg_wifi.cli", *args],
        [sys.executable, "-m", "classg_wifi.cli", *args],
    ]
    last: subprocess.CompletedProcess[str] | None = None
    for cmd in candidates:
        try:
            last = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30,
                cwd=REPO / "services/sensor-wifi",
            )
        except (OSError, subprocess.TimeoutExpired):
            # e.g. not installed, or a non-executable Windows shim on PATH
            continue
        return last
    raise RuntimeError("no way to run classg-sensor-wifi; install the package or make setup")


def check_wifi_command(line: str, where: str) -> None:
    try:
        tokens = shlex.split(line)
    except ValueError:
        # An unbalanced quote or a stray escape in a documented command. Worth
        # nothing to guess at, and worth everything not to abort the whole run
        # over -- a check that dies on one line stops being run at all.
        return
    # normalise the two spellings to the part after the program name:
    # `classg-sensor-wifi ...` and `<python> -m classg_wifi.cli ...`
    for i, t in enumerate(tokens):
        if t.endswith("classg-sensor-wifi") or t == "classg_wifi.cli":
            tokens = tokens[i:]
            break
    subcommands = {"capture", "replay", "analyze", "run"}
    sub = next((t for t in tokens[1:] if not t.startswith("-")), None)
    if sub is None or sub not in subcommands:
        # global invocations: --help, --help-topic <id>
        help_out = wifi_cli("--help")
        for flag in (t for t in tokens[1:] if t.startswith("--")):
            if flag not in help_out.stdout + help_out.stderr:
                fail(f"{where}: {flag} not in classg-sensor-wifi --help")
        if "--help-topic" in tokens:
            topic = tokens[tokens.index("--help-topic") + 1]
            r = wifi_cli("--help-topic", topic)
            if r.returncode != 0:
                fail(f"{where}: --help-topic {topic} exits {r.returncode}")
        return
    help_out = wifi_cli(sub, "--help")
    if help_out.returncode != 0:
        fail(f"{where}: classg-sensor-wifi {sub} --help exits {help_out.returncode}")
        return
    for flag in (t for t in tokens if t.startswith("--")):
        if flag not in help_out.stdout:
            fail(f"{where}: classg-sensor-wifi {sub} does not take {flag}")


def check_command_line(line: str, where: str) -> None:
    line = line.strip()
    if not line or line.startswith("cd "):
        return
    first = line.split()[0]
    if first == "make":
        for target in line.split()[1:]:
            if "=" in target or target.startswith("-"):
                continue
            makefile = (REPO / "Makefile").read_text(encoding="utf-8")
            if not re.search(rf"^{re.escape(target)}:", makefile, re.M):
                fail(f"{where}: no Makefile target '{target}'")
    elif first.startswith("./scripts/") or first.startswith("scripts/"):
        if not (REPO / first.lstrip("./")).is_file():
            fail(f"{where}: {first} does not exist")
    elif first == "npm" and " run " in line:
        script = line.split()[2]
        pkg = json.loads((REPO / "services/ui/package.json").read_text(encoding="utf-8"))
        if script not in pkg.get("scripts", {}):
            fail(f"{where}: npm script '{script}' not in services/ui/package.json")
    elif "classg-sensor-wifi" in first or "classg_wifi.cli" in line:
        check_wifi_command(line, where)
    # everything else: deliberately unchecked (see module docstring)


# Lines that cannot be checked without guessing: placeholders a reader is meant
# to substitute, command substitution, pipelines and continuations. Checking
# those would produce false failures, and a check nobody trusts stops being run.
#
# Trailing comments are NOT in this list, deliberately. They were, and it made
# the whole README pass vacuously: nearly every command in it is written
# `make setup   # what it does`, so skipping any line containing a # skipped
# almost everything. Verified by breaking `make setup` on purpose and watching
# the check stay green. The comment is stripped instead.
SKIP_MARKERS = ("<", "$(", "...", "|", "&&", "\\")


def check_markdown(path: pathlib.Path) -> None:
    """Run the same checks over ```bash fences in a markdown file."""
    where_file = path.relative_to(REPO).as_posix()
    lines = path.read_text(encoding="utf-8").splitlines()
    in_fence = False
    for n, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = stripped.startswith("```bash") or stripped.startswith("```sh")
            continue
        if not in_fence or not stripped:
            continue
        # Strip a trailing comment before the skip test, so `make setup # why`
        # is checked as `make setup`.
        command = stripped.split(" #", 1)[0].rstrip()
        if not command or command.startswith("#"):
            continue
        if any(m in command for m in SKIP_MARKERS):
            continue
        check_command_line(command, f"{where_file}:{n}")


def main() -> int:
    doc = json.loads(GUIDE.read_text(encoding="utf-8"))
    for d in doc["documents"]:
        for section in d.get("sections", []):
            for item in section.get("items", []):
                where = f"{d['id']} / {section['title']} / {item['title']}"
                if "path" in item and not (REPO / item["path"]).exists():
                    fail(f"{where}: path '{item['path']}' does not exist")
                for line in item.get("command", "").splitlines():
                    check_command_line(line, where)
    check_markdown(REPO / "README.md")

    if errors:
        for e in errors:
            print(f"FAIL {e}")
        return 1
    print("operator-guide.json and README.md: all paths, make targets, npm "
          "scripts and classg-sensor-wifi commands check out")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

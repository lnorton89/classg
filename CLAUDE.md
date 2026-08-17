# ClassG — working notes for Claude

Passive, receive-only drone detection for a Raspberry Pi. Four languages, one
schema contract, real hardware at the end of it. Start with [README.md](README.md)
for what the system is; this file is about how to work in it.

## Rule zero: never commit work you did not do

**Multiple agents and humans work in this repo at the same time.** A dirty file
in `git status` is usually someone else's work in progress, not yours.

Never run these. There is no situation in this repo where they are correct:

```
git add -A        git add .         git commit -a        git commit -am
git stash         git reset --hard  git checkout -- .    git clean
```

Every one of them operates on the whole worktree, so every one of them can
swallow or destroy a parallel session's uncommitted work.

Commit with an explicit pathspec, always:

```bash
git commit --only path/to/file.ts path/to/other.go -m "message"
```

Before you commit, run `git status --short` and stage **only** files you
personally edited this session. If it lists files you never touched, that is
another session working — leave them completely alone and do not mention them
in your commit message.

This is not hypothetical. Commit `91dff15 "Add the always-on recording switch
(API side)"` contains an unrelated satellite-basemap rewrite across five UI
files, because a catch-all `git add` ran while another session was mid-edit. It
was already pushed by the time anyone noticed, so it can't be cleanly split.

Most of those commands are denied outright in
[.claude/settings.json](.claude/settings.json). If one is blocked, that is
working as intended — restate the operation with an explicit pathspec rather
than looking for a spelling that gets through. Reaching for `git -C`, a
subshell, or a flag reordering to get the same effect defeats the only
safeguard protecting someone else's uncommitted work.

The deny list matches on command prefixes, so it stops the common forms and not
every possible one. It is a guardrail, not a sandbox — the rule above is what
actually keeps the tree safe.

Full reasoning, recovery recipes, and the amend/force-push rules:
[docs/dev/concurrent-agents.md](docs/dev/concurrent-agents.md).

**Commit only when asked.** Finishing a change is not a request to commit it.

## Commands

`make help` lists everything. The ones that matter:

| Command | What |
|---|---|
| `make dev` | Whole stack in Docker, hot reload. UI on :5173, API on :8081 |
| `make test` | All five suites (wifi, fusion, api, ui, sdr) |
| `make lint` | Mirrors the lint jobs in `.github/workflows/ci.yml`. It does not run the test suites, `sqlc diff`, schema validation, or the security job (`govulncheck`/`pip-audit`/`cargo audit`/`npm audit`) — passing it is necessary but not sufficient for CI |
| `make sense` | Live Wi-Fi sensor. Needs root + `make monitor` first |
| `make compose-up` | Production-shaped web tier |

## Verifying your work

Run the checks for whatever you touched **before** you say it's done, and quote
what you actually ran. A green result you didn't produce isn't evidence.

| You touched | Run |
|---|---|
| `services/ui` | `npm run lint && npm run typecheck && npm test -- --run` |
| `services/api`, `services/fusion` | `go test -count=1 ./...` and `gofmt -l . && go vet ./...` |
| `services/sensor-wifi` | `python -m pytest` and `ruff check . && mypy classg_wifi` |
| `services/sensor-sdr` | `cargo test` and `cargo fmt --check && cargo clippy --all-targets -- -D warnings` |
| anything, before done | `make lint` — lint parity with CI, not the full gate (see above) |

### Checks that lie

**Know what a passing command actually proved.** Two traps here have already
produced false "verified" reports:

- **`tsc --noEmit` on the root `tsconfig.json` checks nothing.** The root is a
  solution file — `"files": []` plus project references — so it resolves an
  empty program and exits 0 no matter how broken the code is. The real check is
  `tsc -b --noEmit`, which walks the referenced projects. If you ever want to
  confirm a typecheck is real, `tsc --noEmit --listFiles | wc -l` should be in
  the thousands, not zero.
- **A passing typecheck says nothing about runtime.** This project talks to
  radios over USB and correlates timing-sensitive frames. Types and tests don't
  catch a wedged adapter, a stale `dist/`, or a tile source that answers past
  its zoom ceiling with a placeholder image at HTTP 200. When a change is
  supposed to alter something observable, observe it — hit the endpoint, load
  the page, replay a PCAP.
- **`prettier --check .` disagrees with CI in a Windows working tree.** It
  reports a different set of files locally than the `ui` job does, on line
  endings that `.gitattributes` normalises on commit — so CI never sees them.
  Both directions bite: it flags files CI is happy with, and running
  `prettier --write .` to "fix" them churns a pile of unrelated files with
  line-ending-only changes while the real offenders stay hidden in the noise.
  Trust the filenames in the failing CI log, fix only those, and confirm the
  change is real with `git diff --ignore-cr-at-eol`.
- **A piped check reports the pipe's exit status, not the command's.**
  `npm test -- --run | tail` exits 0 however the tests went, because that is
  `tail`'s exit code. Chain those with `&&` and you have a green run that
  proved nothing. Redirect to a file and test `$?` instead.

When a check is impossible in your environment, say so plainly and say what you
did instead. "Typecheck passes; I could not test against hardware" is useful.
"Verified" when you only ran a no-op is worse than saying nothing.

## Constraints that are not negotiable

**Receive-only.** ClassG never transmits, jams, spoofs, or takes over a drone.
This is a design constraint, not a disclaimer — see
[docs/research/06-legal-and-ethics.md](docs/research/06-legal-and-ethics.md).
Never add a code path that transmits, and say so if asked to.

**`schemas/` is the cross-language contract.** Four services in four languages
read it. Changing a schema means changing Python, Rust, Go, and TypeScript
together, or you have shipped a silent wire mismatch.

**Sensors degrade, they don't crash the system.** A vanished USB device or a
wedged adapter is an expected failure mode
([ADR-0003](docs/architecture/adr/0003-sensor-process-isolation.md)). Handle it
as a degraded state with an operator-visible reason, not an exception.

## Traps specific to this repo

- **Stale UI.** In dev, Vite serves the UI. If the Go binary serves `dist/`
  instead you'll edit a component, reload, and see yesterday's build. `make
  dev-api` sets `CLASSG_UI_DIR=off` for exactly this reason.
- **The SDR cannot see a DJI.** RTL-SDR V4 tops out at 1.766 GHz; DJI talks on
  2.4/5.8 GHz. No antenna or gain fixes this. Wi-Fi is the DJI sensor.
- **Basemap zoom ceilings are per-source.** Esri serves a grey placeholder at
  HTTP 200 past z19 rather than a 404, so an over-set `BASEMAP_MAX_ZOOM` blanks
  the map instead of blurring it. Three files must agree — see the docker README.
- **Don't publish an image built with a preload bbox.** It redistributes Esri
  imagery. Runtime caching is fine; shipping the cache is not.

## Style

Match the file you're in. This codebase comments the *why* — the reasoning
behind a non-obvious choice, the failure it prevents — and skips narrating the
*what*. Several comments record measurements taken against real hardware; if you
change the behaviour they describe, re-measure or delete them rather than
leaving a confident statement that is no longer true.

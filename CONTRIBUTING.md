# Contributing to ClassG

Issues and pull requests are welcome. This page is the practical version of
the rules; the README's [Contributing](README.md#contributing) section is the
summary.

## Getting a working tree

```bash
git clone --recursive https://github.com/lnorton89/classg
cd classg
make env
make setup     # needs Go 1.26+, Python 3.11+, Rust stable, Node 24+
make test      # all five suites should pass before you change anything
```

No hardware is required to work on most of the codebase — the README's
"Prove the pipeline without hardware" section builds a synthetic capture and
pushes it through the whole stack, and the test suites run entirely offline.

## Before sending a change

**Run the checks for what you touched, and say what you ran.** A green
result nobody reproduced isn't evidence.

| You touched | Run |
|---|---|
| `services/ui` | `npm run format:check && npm run lint && npm run typecheck && npm test -- --run` |
| `services/api`, `services/fusion` | `go test -count=1 ./...` and `gofmt -l . && go vet ./...` |
| `services/sensor-wifi` | `python -m pytest` and `ruff check . && mypy classg_wifi` |
| `services/sensor-sdr` | `cargo test` and `cargo fmt --check && cargo clippy --all-targets -- -D warnings` |
| anything | `make lint` — lint parity with CI, though not the whole gate |

Two parity traps that have already put red on `main`: CI installs UI
dependencies with `npm ci` from nothing (a lockfile that only resolves
against your existing `node_modules` will fail), and the Go jobs run with
`GOTOOLCHAIN=local` (a `go.mod` toolchain bump your runner would silently
download will not be downloaded there).

## The rules that are not style preferences

- **Receive-only, absolutely.** No code path may transmit, jam, spoof,
  deauthenticate, or take over a drone or a network. This is a design
  constraint with a legal rationale —
  [docs/research/06-legal-and-ethics.md](docs/research/06-legal-and-ethics.md) —
  and a PR that violates it will be declined regardless of its other merits.
- **`schemas/` is a four-language contract.** Changing a schema means
  changing Python, Rust, Go, and TypeScript together, plus the generated UI
  types (`npm run gen:types`), or you have shipped a silent wire mismatch.
- **Sensors degrade; they do not crash the system.** A vanished USB device is
  an expected state with an operator-visible reason, not an exception
  ([ADR-0003](docs/architecture/adr/0003-sensor-process-isolation.md)).

## Style

Match the file you are in. Comments explain *why* — the failure a choice
prevents, the measurement that justified it — and skip narrating the *what*.
Several comments record measurements taken against real hardware; if your
change invalidates one, re-measure or delete it rather than leaving a
confident statement that is no longer true. The docs hold themselves to the
same standard: no command goes in a doc unless it was actually run.

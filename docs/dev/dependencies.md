# Dependencies

Four languages, four package managers, one CI gate. This file records what is
pinned, what is deliberately held back, and why — so nobody spends an afternoon
re-attempting an upgrade that was already tried and reverted.

**Before changing any version here, read [Held back](#held-back).** Every entry
is something that looked routine, was attempted, and broke. The reasons are
recorded because the failure mode is always the same: the upgrade installs
locally, the lint passes, and CI fails on a clean install.

## Toolchain versions

| Thing | Pinned where | Version | Why pinned there |
|---|---|---|---|
| Go | `services/*/go.mod` | `1.26.6` | A **patch** pin, not `1.26`. `go 1.26` resolves to `1.26.0`, which carries 15 stdlib CVEs that `govulncheck` fails on. |
| Go (CI) | `.github/workflows/ci.yml` | `go-version-file` | Reads `go.mod`. Never write a literal — see [The Go version trap](#the-go-version-trap). |
| Go (image) | `services/*/Dockerfile` | `golang:1.26.6-bookworm` | Must match `go.mod`, for the same CVE reason. |
| Node | `.github/workflows/ci.yml` | `24` | |
| Rust | rustup default | stable | `sensor-sdr` has no MSRV pin; `cargo clippy -D warnings` is the gate. |
| Python | `services/sensor-wifi` | 3.11+ | |
| sqlc | `.github/workflows/ci.yml` | `1.31.1` | `sqlc diff` compares committed generated code against what this exact version produces. A different version reformats and fails the diff. |

## The Go version trap

`GOTOOLCHAIN: local` in CI means the runner may not download a newer Go. So a
literal `go-version: "1.26"` resolves to whatever patch the runner image ships,
and the build fails the moment `go.mod` asks for a higher patch:

```
go: go.mod requires go >= 1.26.6 (running go 1.26.5; GOTOOLCHAIN=local)
```

This is not hypothetical — it turned CI red across two commits. Locally it is
invisible, because a developer's `GOTOOLCHAIN` is usually `auto`, which silently
downloads 1.26.6 and runs the tests perfectly.

**The fix is `go-version-file:`, pointing at the same `go.mod` that declares the
requirement.** Both Go jobs and the security job now do this. Do not replace it
with a literal.

## Chosen deliberately

Dependencies where the obvious alternative was rejected for a reason worth
recording.

### `graphql-go/graphql` rather than `gqlgen`

`POST /api/v1/graphql` is served by
[graphql-go/graphql](https://github.com/graphql-go/graphql) v0.8.1, which has
**zero external dependencies** — `go list -deps` reaches nothing outside the
standard library and its own subpackages. `gqlgen` is the more active project
and the more idiomatic choice for a large schema, but it brings roughly a dozen
modules and a code-generation step that would need its own drift gate in CI,
the way `sqlc diff` does. For one Pi serving one operator, a schema built
programmatically in `internal/graphqlapi` and read by the executor at runtime is
the smaller thing to own.

Upstream is low-activity, and that is the accepted risk. The exit is cheap
because nothing outside `internal/graphqlapi` imports it: the schema is Go
structs with the domain types' own `json` tags, and swapping executors means
rewriting the type definitions, not the resolvers or anything that calls them.

Re-check this if the schema grows mutations — codegen earns its keep once
inputs, unions and subscriptions arrive, and none of those exist here.

## Held back

Upgrades that were attempted and reverted. Each one is blocked by something
outside this repo; re-check the linked issue before trying again.

### ESLint stays on 9.x

`eslint@10` cannot be installed. `eslint-plugin-jsx-a11y` — which the config
uses and which has no 10-compatible release at any version, 6.10.2 being the
newest — declares `peer eslint@"^3 || ... || ^9"`. `npm ci` refuses the tree:

```
Could not resolve dependency:
peer eslint@"^3 || ... || ^9" from eslint-plugin-jsx-a11y@6.10.2
Conflicting peer dependency: eslint@9.39.5
```

`npm install` on an existing `node_modules` does not surface this, and neither
does `npm run lint`. Only a clean `npm ci` does — which is what CI runs, and
which is why this shipped broken. **Test dependency changes with `rm -rf
node_modules package-lock.json && npm install && npm ci`, never with an
incremental install.**

`--legacy-peer-deps` would make it install and is the wrong answer: the peer
range is a real statement about which ESLint API the plugin calls.

### TypeScript stays on 5.x

`typescript-eslint` does not support TypeScript 7
([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).
Upgrading TypeScript alone makes every typed lint rule unavailable.

### `@eslint/js` stays on 9.x

`@eslint/js@10.0.1` peer-conflicts with the ESLint version this repo can
actually run. It moves when ESLint does.

## Checking a dependency change

`make lint` does **not** cover this. It runs the linters against an already
installed tree, so it cannot see a resolution failure. The full check:

```bash
# UI — the clean install is the point; an incremental one hides conflicts
cd services/ui
rm -rf node_modules package-lock.json
npm install && npm ci
npm run lint && npm run typecheck && npm test -- --run
npm audit --audit-level=high

# Go — vet and test with the toolchain go.mod actually asks for
cd services/api && GOTOOLCHAIN=local go vet ./... && go test -race -count=1 ./...
go run golang.org/x/vuln/cmd/govulncheck@latest ./...

# Rust
cd services/sensor-sdr && cargo test && cargo clippy --all-targets -- -D warnings
cargo audit

# Python
cd services/sensor-wifi && python -m pytest && ruff check . && mypy classg_wifi
pip-audit
```

`GOTOOLCHAIN=local` on the Go commands is what reproduces CI. Without it your
toolchain quietly upgrades itself and you learn nothing.

## Provisioning

Installing these on a Pi — including the RTL-SDR Blog fork of librtlsdr, which
is not the `librtlsdr-dev` in apt — is [docs/ops/09-deployment.md](../ops/09-deployment.md).

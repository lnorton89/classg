# ADR-0006: libSQL (Turso) for storage, local-first with optional sync

**Status:** Accepted · **Date:** 2026-08-10 · **Supersedes:** the plain-SQLite assumption in
[overview.md](../overview.md)

## Context

The API needs durable storage for detections, tracks, captures, and config. The original design
said "SQLite with WAL". The requirement is now [Turso](https://turso.tech/).

The deployment shapes the decision: a Raspberry Pi, frequently **in a field with no
connectivity**, recording data that must not be lost.

## Decision

**libSQL via `github.com/tursodatabase/go-libsql`, in synced-database mode.**

> **Corrected 2026-08-20.** This ADR said "embedded-replica mode" from the start, and the code
> called `NewEmbeddedReplicaConnector` to match. That name is misleading: in this library an
> *embedded replica* writes **through to the remote primary** and keeps the local file only as a
> read cache. So the local-first guarantee stated below was never what ran. The mode that
> actually delivers it is `NewSyncedDatabaseConnector`, which differs by exactly one flag
> (`offline=true`). The code now uses it; the rest of this ADR describes the intent, unchanged,
> and is finally accurate.

- **libSQL, not "Turso Database".** libSQL is the production-ready SQLite fork. Turso's newer
  from-scratch Rust rewrite is promising but too young for a system that runs unattended and
  whose data cannot be regenerated.
- **Local file is the primary read/write path.** Sync to Turso Cloud is an optional
  enhancement layered on top, never a dependency.
- **Zero credentials = zero network.** With `CLASSG_TURSO_URL` / `CLASSG_TURSO_AUTH_TOKEN`
  unset, the service runs against a purely local libSQL file with no degraded functionality.
  This is the default path and is tested as such.

The genuine win over plain SQLite is a synced database: local-first writes that survive total
connectivity loss, with the option of syncing to a durable remote when a network appears. That
maps onto "Pi in a field, occasionally brought home" almost exactly.

## Consequence 1: everything syncs, by decision

Sync introduces a question plain SQLite did not: operator locations are **pilot ground
positions**, and syncing them to a third-party cloud is a different posture from keeping them
on the device.

It was raised and **the operator of this system decided it is not a concern for this
deployment**. So: one database, sync covers everything, uniform retention, and
`CLASSG_EXPOSE_OPERATOR_LOCATION` defaults to true. The earlier design — two databases and
unconditional sync exclusion — is dropped, which is a genuine simplification.

Recorded because it is a deliberate choice rather than an oversight. Anyone redeploying this
in a different context, particularly under GDPR where operator position is personal data,
should revisit it. The `Store` interface below is where that separation would go back in.

## Consequence 2: CGO, and the loss of the static binary

`go-libsql` requires `CGO_ENABLED=1`. Precompiled native libraries ship for linux/amd64,
**linux/arm64** (the Pi), darwin/amd64, and darwin/arm64, so no native compilation is needed —
but the pure-static-binary property claimed in [ADR-0001](0001-language-split.md) is gone.

Practical fallout:

- Cross-compiling to arm64 from a dev machine now needs a CGO toolchain or a Docker buildx
  step. Building on the Pi remains the simplest route.
- CI must set `CGO_ENABLED=1` for anything touching storage.
- Storage sits behind a `Store` interface so the API and CLI test suites can run against an
  in-memory or temp-file implementation, keeping CGO from infecting every test.

Worth stating plainly: a single static binary was a real operational advantage on a Pi, and
this trades it away. The local-first sync capability is judged worth the trade; if it later
proves not to be, the `Store` interface is the seam that makes reverting cheap.

## Alternatives rejected

| Option | Why not |
|---|---|
| Plain SQLite | Simpler and static-linkable, but no sync path. Still the fallback if libSQL proves troublesome — the `Store` interface preserves that exit. |
| Turso Cloud only (no local file) | **Disqualifying.** A drone detector that stops recording when the internet drops is useless in exactly the field deployment it is built for. |
| Turso Database (Rust rewrite) | Too young for unattended operation on data that cannot be regenerated. Revisit later. |
| Postgres | Absurd for a single-node Pi appliance. |

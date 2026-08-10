# ADR-0006: libSQL (Turso) for storage, local-first with optional sync

**Status:** Accepted · **Date:** 2026-08-10 · **Supersedes:** the plain-SQLite assumption in
[overview.md](../overview.md)

## Context

The API needs durable storage for detections, tracks, captures, and config. The original design
said "SQLite with WAL". The requirement is now [Turso](https://turso.tech/).

The deployment shapes the decision: a Raspberry Pi, frequently **in a field with no
connectivity**, recording data that must not be lost.

## Decision

**libSQL via `github.com/tursodatabase/go-libsql`, in embedded-replica mode.**

- **libSQL, not "Turso Database".** libSQL is the production-ready SQLite fork. Turso's newer
  from-scratch Rust rewrite is promising but too young for a system that runs unattended and
  whose data cannot be regenerated.
- **Local file is the primary read/write path.** Sync to Turso Cloud is an optional
  enhancement layered on top, never a dependency.
- **Zero credentials = zero network.** With `CLASSG_TURSO_URL` / `CLASSG_TURSO_AUTH_TOKEN`
  unset, the service runs against a purely local libSQL file with no degraded functionality.
  This is the default path and is tested as such.

The genuine win over plain SQLite is embedded replicas: local-first writes that survive total
connectivity loss, with the option of syncing to a durable remote when a network appears. That
maps onto "Pi in a field, occasionally brought home" almost exactly.

## Consequence 1: operator location must never leave the device

This is the significant one, and it did not exist under plain SQLite.

[data-model.md](../data-model.md#retention) already isolates operator location — the **pilot's
ground position** — in its own store with short retention. Introducing a remote sync target
turns that from a retention convenience into a **privacy boundary**. Syncing a database of
pilot positions to a third-party cloud is a materially different posture from keeping it on
the device, and no user asked for it.

**Operator location is excluded from sync, unconditionally.** If per-table sync exclusion
cannot be expressed, the implementation uses two databases: a syncable one for
tracks/detections/captures, and a local-only one for operator positions.

This is not configurable. There is no flag to turn it on.

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

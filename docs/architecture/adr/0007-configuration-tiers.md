# ADR-0007: Three configuration tiers — bootstrap env, database settings, YAML seed

**Status:** Accepted · **Date:** 2026-08-10 · **Amends:** [ADR-0006](0006-storage-turso-libsql.md) · **Amended:** 2026-08-18 (see below)

## Context

Configuration has drifted into three overlapping mechanisms with no stated precedence:

- ~30 `CLASSG_*` environment variables, all equal citizens in `config.Load`
- `docker-compose.yml` re-declaring 25 of them with its own `${VAR:-default}` fallbacks
- Go-side defaults inside `config.Load`, which are a *third* set of values
- `.env.example` shipping `CLASSG_STORE=memory`, contradicting the Go default of `libsql`
  and the Compose default of `libsql`

The concrete symptom: **three files disagreed about the default store**, and the production
checklist in `docs/ops/00-configuration.md` instructed operators to fix a default that was
already correct in two of the three places. Nobody could say what the effective value was
without reading all three.

The deeper problem is not the wrong default. It is that a setting's *source* is invisible, so
"why is this value what it is" requires archaeology.

## Decision

Three tiers, with a single stated precedence and — critically — **the source of every
effective value reported at runtime**.

### Tier 1 — Bootstrap (environment only)

The minimum needed to find and open the store, plus secrets. Cannot live in the database,
because they are what makes the database reachable.

| Variable | Why it must be env |
|---|---|
| `CLASSG_ENV_FILE` | selects the env file itself |
| `CLASSG_STORE` | chooses the backend before one exists |
| `CLASSG_DB` | where the backend is |
| `CLASSG_LISTEN` | must bind before serving anything |
| `CLASSG_LOG_LEVEL` | needed to log configuration loading |
| `CLASSG_CONFIG_SEED` | where the seed file is |
| **`CLASSG_TURSO_URL`** | **secret** |
| **`CLASSG_TURSO_AUTH_TOKEN`** | **secret** |

That is the whole list. `.env` is for these and nothing else. *(Amended
2026-08-18: the list has grown — see the amendment at the end.)*

### Tier 2 — Settings (database)

Everything else: bus endpoints and topics, retention windows, expected sensors, stale
thresholds, capture parameters, `ExposeOperatorLocation`, max history, restart command.

Stored in a `settings` table, read at startup, mutable at runtime through the existing
`PUT /config/*` endpoints in the [API contract](../api-contract.md). Changing retention should
not require an operator to edit a file and restart a detector that is currently watching the
sky.

### Tier 3 — Seed (YAML)

`config/defaults.yaml` at the repository root. It is:

- the source of initial values when the database is first created, and
- the **entire** configuration when `CLASSG_STORE=memory`

**YAML, not TOML**, purely for consistency: `channels.yaml`, `oui_fingerprints.yaml` and
Compose are already YAML, and a second config dialect earns nothing.

This makes `memory` mode coherent rather than a degraded special case — it is the seed file
with no persistence, which is exactly right for CI and for a dev machine.

### Precedence, and the part that matters

```
Tier 1 keys:  environment            (nothing else may set them)
Tier 2 keys:  environment  >  database  >  seed YAML  >  built-in default
```

Environment override of a Tier 2 key stays legal — containers and CI genuinely need it — but
it is **never silent**:

```jsonc
// GET /config
{ "retention_detections": { "value": "168h", "source": "env",  "mutable": false },
  "sensor_stale_after":   { "value": "30s",  "source": "db",   "mutable": true  },
  "max_history":          { "value": 512,    "source": "seed", "mutable": true  } }
```

The UI renders `source: "env"` settings as read-only with the reason. This is the actual fix:
the problem was never that values came from several places, it was that you could not tell
which place any given value came from.

## Consequences

- **`docker-compose.yml` stops declaring 25 environment variables.** It passes Tier 1 only.
  Everything else comes from the seeded database in the `classg-data` volume.
- **`.env.example` shrinks to the Tier 1 list**, which also removes the wrong `memory` default
  and the contradiction with the Go and Compose defaults.
- Built-in Go defaults remain as the last fallback, so a missing seed file is survivable — but
  the seed file is the documented place to read them.
- **Migration is a breaking change for existing deployments.** Any Tier 2 variable still set in
  the environment keeps working and is reported as `source: "env"`, so nothing breaks silently;
  operators move them into the seed or the database at their own pace.
- One new failure mode to guard: a seed file that no longer matches the settings schema. Seed
  loading validates against the known key set and fails loudly at startup on an unknown key,
  rather than silently ignoring a typo'd setting that the operator believes is in effect.

## Alternatives rejected

| Option | Why not |
|---|---|
| Keep everything in env (12-factor purist) | Cannot change retention or channel weights without a restart, and the invisible-source problem is unsolved. |
| Everything in DB, no env override at all | Breaks CI and container deployment, where injecting one value is routine. |
| TOML for the seed | A second config dialect for no benefit; the repo is already YAML. |
| Ban env override, error on Tier 2 env vars | Considered seriously — it forces the migration to complete. Rejected as too brittle for CI, and reporting `source` achieves the same visibility without the breakage. |

---

## Amendment — 2026-08-18

The Tier 1 table above is the list as originally decided, and it has since
grown — for the reason the tier exists, not against it. Authentication and
mail (`CLASSG_AUTH_MODE`, `CLASSG_SESSION_TTL`, the `CLASSG_OIDC_*` group,
the `CLASSG_SMTP_*` group) are Tier 1 by the same test the original eight
passed: they are secrets, or they are settings a unit must not let its own
web UI change — an auth mode editable through the web interface can be
switched off by whoever already got in, and a password in the settings table
is readable by anything that can read `/config/settings`.

So "that is the whole list" holds for *kinds* — bootstrap and secrets,
nothing else — rather than for the eight names. The current concrete list is
maintained in [docs/ops/00-configuration.md](../../ops/00-configuration.md),
which is the operational reference; this ADR records why the tier is shaped
the way it is.

# Configuration

Three tiers, one stated precedence, and — the part that matters — every effective value
reports where it came from. See [ADR-0007](../architecture/adr/0007-configuration-tiers.md).

```
environment  >  database  >  config/defaults.yaml  >  built-in default
```

## Tier 1 — `.env`: bootstrap and secrets only

The short list needed to find and open the database, plus secrets. These cannot live in the
database because they are what makes it reachable.

| Variable | Purpose |
|---|---|
| `CLASSG_ENV_FILE` | selects a specific env file |
| `CLASSG_STORE` | `libsql` (default) or `memory` |
| `CLASSG_DB` | database path |
| `CLASSG_LISTEN` | listen address |
| `CLASSG_LOG_LEVEL` | `debug` · `info` · `warn` · `error` |
| `CLASSG_CONFIG_SEED` | path to the seed file |
| **`CLASSG_TURSO_URL`** | **secret** — omit for a purely local database |
| **`CLASSG_TURSO_AUTH_TOKEN`** | **secret** |
| `CLASSG_AUTH_MODE` | `required` (default) or `off` |
| `CLASSG_SESSION_TTL` | sliding session lifetime, default `12h` |
| `CLASSG_OIDC_ISSUER` | SSO discovery root — all four OIDC variables together or none |
| `CLASSG_OIDC_CLIENT_ID` | |
| **`CLASSG_OIDC_CLIENT_SECRET`** | **secret** |
| `CLASSG_OIDC_REDIRECT_URL` | must match what is registered at the provider |
| `CLASSG_OIDC_AUTO_PROVISION` | create an account on first SSO login, default `false` |
| `CLASSG_OIDC_ROLE` | role for auto-provisioned accounts — `viewer` or `operator`, never `admin` |
| `CLASSG_SMTP_HOST` | mail server for email hooks |
| `CLASSG_SMTP_PORT` | default 587, or 465 with `CLASSG_SMTP_TLS=true` |
| `CLASSG_SMTP_USERNAME` | |
| **`CLASSG_SMTP_PASSWORD`** | **secret** |
| `CLASSG_SMTP_FROM` | envelope sender; required when `CLASSG_SMTP_HOST` is set |

**Authentication and SMTP are Tier 1 rather than Tier 2, and that is not an
oversight.** A password in the settings table would be readable by anything that
can read `/config/settings`, and a unit whose auth mode is editable through its
own web UI can be switched off by whoever already got in.

## Tier 2 — the database: everything else

Bus endpoints and topics, retention windows, expected sensors, capture defaults, operator
location exposure, history depth, the receiver's own ground position. Read at startup, changed
at runtime:

```bash
curl localhost:8081/api/v1/config/settings
curl -X PUT localhost:8081/api/v1/config/settings \
  -d '{"retention.tracks":"720h"}'
```

Changing retention should not mean editing a file and restarting a detector that is currently
watching the sky.

## Tier 3 — `config/defaults.yaml`: the seed

Seeds the database on first run, and is the **entire** configuration when
`CLASSG_STORE=memory` — which is what makes memory mode coherent for CI and dev rather than a
degraded special case.

Editing it after first run is deliberately inert. The database is authoritative from then on.

## Environment overrides are legal, but never silent

Setting a Tier 2 variable in the environment still works — containers and CI need it — and it
is reported everywhere:

- `classg-api` logs a warning naming every overridden key at startup
- `GET /config/settings` returns `"source": "env"` and lists the key in `env_overridden`
- the UI renders those fields read-only with the reason
- `PUT` on an env-held key returns `409` rather than storing a value the process will ignore

The original problem was never that values came from several places. It was that you could not
tell which place any given value came from — three files disagreed about the default store and
the production checklist told operators to fix a default that was already correct in two of
them.

### External data sources

The optional third-party integrations — network ADS-B, terrain elevation, the
aircraft and OUI registries — are **Tier 2** like everything else that is not
bootstrap or a secret. They seed from `config/defaults.yaml`, report a source
through `GET /config/settings`, and are `PUT`-able at runtime. They are
documented together with the data they need in
[07-external-data.md](07-external-data.md) rather than split across this file,
because turning one on means fetching a file as often as it means setting a
value.

Two caveats worth stating plainly:

- **Fusion reads the environment, not the database.** A value stored through
  `PUT` changes the API's view and not fusion's until the corresponding
  `CLASSG_*` variable is set and fusion restarts. This is not new to these keys
  — `fusion.track_ttl` and the bus endpoints have always worked this way — but
  it does mean the settings page is a source of truth for what *should* be
  configured, not proof of what fusion is running.
- **`VITE_BASEMAP_VECTOR_URL` is not a setting at all.** Vite substitutes it at
  build time, so it cannot be in the registry; it belongs with the other
  `VITE_*` build variables.

## Bootstrap

```bash
cp .env.example .env
# or: make env
```

`.env.example` is committed and contains safe development defaults. `.env` and
`.env.local` are ignored and may contain deployment-specific values or secrets.
Never put `CLASSG_TURSO_AUTH_TOKEN` in the committed example.

Precedence is consistent:

1. An explicit process environment variable wins.
2. `CLASSG_ENV_FILE=/absolute/path/to/file` selects a specific file.
3. Otherwise, services find the nearest `.env` by walking toward the repository root.
4. Built-in defaults are the final fallback.

The API, fusion executable, the Wi-Fi CLI, and the SDR sensor's `adsb` loop
implement this loading directly. Vite uses the repository root as its `envDir`.
Compose is invoked with `--env-file .env` by `make compose-up`. BLE variables
remain reserved until that sensor's runtime loop lands (Milestone 4).

`CLASSG_DETECTION_ENDPOINT` and the socket mode variables describe both ends of
the sensor bus. An all-native run uses a binding sensor and a dialing fusion.
Putting fusion in a container reverses ownership: fusion listens on Compose's
published port and the host sensor connects outward to it, because a container's
loopback is not the host's. See [docker/README.md](../../docker/README.md).

## Development loop

```bash
make dev          # whole stack in Docker, hot reload, no image rebuilds
make dev-logs     # follow all three services
make dev-down     # stop
```

| | URL |
|---|---|
| **Web app** | **http://localhost:5173** (Vite) |
| API | http://localhost:8081/api/v1 |

**The web app is not on 8081.** In development the API runs with
`CLASSG_UI_DIR=off` and serves only `/api/v1`; Vite serves the app. Loading 8081 in a browser
returns a message saying exactly that. If the Go binary also served a built `dist/` you would
edit a component, reload, and see yesterday's build.

Verified working end to end: a saved `.go` file triggers an in-container rebuild in about four
seconds, and the UI hot-reloads through Vite.

### Alternatives

```bash
make dev-native     # host processes instead of containers (for a Pi)
make dev-ui-only    # vite alone against MSW mocks, no Go at all
```

**Do not run both at once.** They claim the same ports, so whichever starts second either
fails to bind or leaves you talking to the other loop — an API that answers, but from the
wrong process, with configuration you did not set. `make dev` refuses to start when it detects
a native loop.

`make dev-native` runs the three processes directly on the host instead of in containers. On a
Pi that is the faster loop, because an image rebuild costs real time there; the price is
needing Go, Node, and `air` installed on the machine rather than in an image.

Two details that remove the rebuild step entirely:

- The API runs with `CLASSG_UI_DIR=off`, so **Vite serves the UI**, not the Go binary. Serving
  a stale `dist/` is the most confusing failure here — you edit a component, reload, and see
  yesterday's build.
- Go reloads automatically if [`air`](https://github.com/air-verse/air) is installed
  (`go install github.com/air-verse/air@latest`); otherwise it falls back to `go run` and you
  restart by hand. `services/api/.air.toml` is committed.

Use `make compose-up` when you specifically want to exercise the container path.

## Other commands

```bash
make setup
make test
make build-ui
make compose-up
```

Command-line flags still override Wi-Fi sensor defaults. Systemd should use
`EnvironmentFile=/path/to/classg/.env`; environment values supplied by systemd
therefore remain authoritative over automatic dotenv loading.

The Sensors page reads its capture controls from the API's resolved
`CLASSG_WIFI_INTERFACE`, `CLASSG_WIFI_CHANNEL`, `CLASSG_CAPTURE_DURATION_S`, and
`CLASSG_CAPTURE_LABEL` values. The interface is read-only in the browser. Sensor
restart uses `CLASSG_SENSOR_RESTART_COMMAND`; when that executable is not
available in the API runtime, the UI disables restart and shows the reason
instead of reporting a false success.

## Production checklist

- **Confirm `CLASSG_STORE=libsql`.** The Go default and the Compose default are both `libsql`;
  a committed `.env.example` shipped `memory`, so a `.env` copied from it silently disagreed
  with both. Persistence is the default and `memory` is for CI and dev only.
- Use an absolute `CLASSG_DB` path on persistent storage.
- `CLASSG_EXPOSE_OPERATOR_LOCATION` defaults to **true** for this deployment
  ([ADR-0006](../architecture/adr/0006-storage-turso-libsql.md)). Set it `false` if you
  redeploy somewhere the pilot's ground position should not be shown.
- Declare every expected sensor in `CLASSG_EXPECTED_SENSORS` so a sensor that
  never starts appears as unhealthy rather than disappearing. The form is
  `id:kind[:optional]`, e.g. `wifi-0:wifi,sdr-0:sdr:optional`. Mark hardware
  this unit may not have fitted as `optional` — it stops `/health` sitting at
  `degraded` forever on a build with no SDR, without hiding the failure of one
  that is fitted: once a sensor has heartbeated, going quiet degrades health
  whether it was declared optional or not.
- Keep the ZMQ endpoints bound to loopback or a trusted private network.
- **Leave `CLASSG_AUTH_MODE` at `required`.** On first start the unit has no
  accounts and serves only the setup screen until you create the first
  administrator; there is no default password. `off` exists for a bench unit and
  is logged loudly, reported by `/system`, and bannered in the web app.
- **Leave `hooks.allow_private_targets` off** unless a webhook target genuinely
  is on the LAN. With it on, a hook can reach this API on loopback and any host
  on the local network — including a cloud metadata service at 169.254.169.254.
- If you configure SSO, keep `CLASSG_OIDC_AUTO_PROVISION` off unless the
  provider only issues tokens to people who should have access. With it on,
  "SSO configured" means "anyone your IdP will authenticate is a user here".

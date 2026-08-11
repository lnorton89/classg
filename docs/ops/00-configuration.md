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

## Tier 2 — the database: everything else

Bus endpoints and topics, retention windows, expected sensors, capture defaults, operator
location exposure, history depth. Read at startup, changed at runtime:

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

The API, fusion executable, and Wi-Fi CLI implement this loading directly. Vite
uses the repository root as its `envDir`. Compose is invoked with `--env-file
.env` by `make compose-up`. SDR and BLE variables remain reserved until their
runtime loops land.

`CLASSG_DETECTION_ENDPOINT` and the socket mode variables describe both ends of
the sensor bus. Native Linux uses a binding sensor and dialing fusion. The
Windows/WSL Docker layout reverses ownership: fusion listens on Compose's
published port and the WSL sensor connects to `host.docker.internal`. This avoids
assuming that container loopback and WSL loopback are the same network.

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

**Do not run both at once.** WSL forwards `localhost` to a native process in preference to a
container publishing the same port, so a native loop silently shadows the containers — the API
answers, but from the wrong process, with configuration you did not set. `make dev` refuses to
start when it detects one.

`make dev` runs the three processes directly rather than in containers. Containers are the
deployment story; for editing they cost either an image rebuild or a bind mount whose inotify
events do not reliably cross the Windows/WSL boundary, so file watchers silently miss changes.

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

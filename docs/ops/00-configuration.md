# Configuration

> **Being restructured — see [ADR-0007](../architecture/adr/0007-configuration-tiers.md).**
> Configuration is moving to three tiers: a short bootstrap/secrets list in `.env`, runtime
> settings in the database, and `config/defaults.yaml` as the seed. This page describes the
> current all-environment-variable behaviour, which still works and is reported as
> `source: "env"` after the migration.

ClassG uses one root `.env` file for every module. Variable names are namespaced
by service, while bus topology and API topics are shared. This keeps local runs,
systemd deployments, Vite, and Docker Compose on the same reviewed contract.

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
make dev            # fusion + api + vite, native, hot reload, no rebuilds
make dev-ui-only    # vite alone against MSW mocks, no Go at all
```

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
  never starts appears as unhealthy rather than disappearing.
- Keep the ZMQ endpoints bound to loopback or a trusted private network.

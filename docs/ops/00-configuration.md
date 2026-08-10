# Configuration

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

## Reproducible commands

```bash
make setup
make test
make build-ui
make dev-api
make dev-ui
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

- Change `CLASSG_STORE=memory` to `libsql`.
- Use an absolute `CLASSG_DB` path on persistent storage.
- Keep `CLASSG_EXPOSE_OPERATOR_LOCATION=false` unless disclosure is deliberate.
- Declare every expected sensor in `CLASSG_EXPECTED_SENSORS` so a sensor that
  never starts appears as unhealthy rather than disappearing.
- Keep the ZMQ endpoints bound to loopback or a trusted private network.

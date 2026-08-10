# Docker: use it where it helps, not everywhere

**Recommended split on the Pi:**

| Component | Where | Why |
|---|---|---|
| `sensor-wifi`, `sensor-sdr`, `sensor-ble` | **systemd on the host** | Need raw USB access, monitor-mode interfaces, and network-namespace visibility |
| `fusion`, `api`, `ui`, storage | **containers** | Dependency isolation for the web stack, easy rebuilds, no hardware coupling |

Containerising the sensors is usually more friction than it's worth:

- Monitor-mode interfaces live in the **host** network namespace. `network_mode: host`
  works, but you've now given up the isolation that was the reason to containerise.
- USB device passthrough needs `--privileged` or careful `--device` mapping, and **breaks on
  replug** — the device node changes and the container doesn't follow it. Given that a wedged
  or replugged adapter is an expected failure mode here (see
  [ADR-0003](../docs/architecture/adr/0003-sensor-process-isolation.md)), that's a bad trade.
- systemd already gives exactly what the sensors need: supervision, restart backoff, and
  `ExecStartPre=` for monitor-mode setup.

So: `docker-compose.yml` covers the web tier. Sensors get systemd units.

## Web tier

```bash
docker compose up -d
```

Then `http://<pi>:8080`.

## If you really want sensors in containers

For a dev machine where hardware isn't attached, or CI:

```yaml
sensor-wifi:
  build: ../services/sensor-wifi
  network_mode: host
  cap_add: [NET_ADMIN, NET_RAW]
  devices:
    - /dev/bus/usb:/dev/bus/usb
```

Expect to restart the container after any adapter replug. This is fine for replaying PCAPs
(`classg-sensor-wifi replay`), which needs no hardware at all — and that's the case where
containers genuinely earn their keep here.

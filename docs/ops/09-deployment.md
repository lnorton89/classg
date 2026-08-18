# Deploying to the Pi

How the stack is installed, run, and updated on a real unit. Provisioning the
box comes first — [01-pi-setup.md](01-pi-setup.md) → [02-wifi-adapter.md](02-wifi-adapter.md)
→ [03-sdr-setup.md](03-sdr-setup.md) — this document assumes the radios already
work.

## The layout

One split, chosen in [docker/README.md](../../docker/README.md) and worth
restating because everything below follows from it:

| Component | Runs as | Why |
|---|---|---|
| `fusion`, `api`, `ui` | Docker Compose (`classg-fusion`, `classg-api`, `classg-ui`) | Dependency isolation, easy rebuilds, no hardware coupling |
| `sensor-wifi`, `sensor-sdr` | systemd units on the host | Raw USB, monitor-mode interfaces, and survival of a replug — containers break on all three |
| `dump1090-mutability` | its own systemd service, from the Debian package | It owns the SDR ([ADR-0008](../architecture/adr/0008-adsb-via-dump1090.md)); `sensor-sdr` only reads its TCP output |

The repo is checked out at `~/classg` and is the deployment: binaries run from
the checkout, the systemd units are rendered against its absolute path, and
updating is a `git pull`. There is no separate install prefix to drift out of
sync with the source that built it.

Ports, once up: **UI on :8080** (nginx serves the built app), **API on :8081**
(`/api/v1` only — the API runs with `CLASSG_UI_DIR=off`, so a bare `GET /`
on 8081 returns a message saying exactly that, which is not a fault).

## The bus crosses the container boundary — get the direction right

The sensors are on the host and fusion is in a container, so fusion **listens**
on the published :5556 and both sensors **connect** outward to it. This is the
reverse of the committed `.env.example` defaults, which describe the all-native
layout where the sensor binds. A sensor left in `bind` mode on a Compose unit
publishes to a loopback socket nothing is dialing, and the failure is silent —
healthy-looking sensor, empty API. In `.env`:

```dotenv
CLASSG_DETECTION_ENDPOINT=tcp://127.0.0.1:5556
CLASSG_WIFI_SOCKET_MODE=connect
```

The SDR sensor already defaults to `connect` (and its unit file says so
again); fusion's listen side is set inside `docker-compose.yml`. Only the
Wi-Fi sensor's mode has to be set in `.env`, which is why it is the one to
forget.

Because Compose sets `CLASSG_FUSION_DETECTION_SOCKET_MODE: listen` literally
rather than through `${...}`, **any value for it in `.env` is ignored by the
container** — it reaches only a native `make dev-native` run. The live unit
carries `CLASSG_FUSION_DETECTION_SOCKET_MODE=dial` in `.env` and its fusion
container listens regardless, which reads as a contradiction until you know
which of the two wins. Confirm the reality rather than the file:
`ss -lptn 'sport = :5556'` shows `docker-proxy` holding the port when fusion
is listening. The full
reasoning is in [docker/README.md](../../docker/README.md#crossing-the-container-boundary).

## Install

From a provisioned Pi ([01-pi-setup.md](01-pi-setup.md) — including Docker):

```bash
cd ~ && git clone https://github.com/lnorton89/classg && cd classg
make env                      # then edit .env: CLASSG_WIFI_SOCKET_MODE=connect
                              # (the committed default is bind -- see above)
```

### 1. Web tier

```bash
make compose-up               # docker compose --env-file .env -f docker/docker-compose.yml up -d --build
curl -s localhost:8081/api/v1/health | head
```

First build on a Pi takes a while; subsequent `compose-up` runs only rebuild
what changed. The containers restart themselves (`restart: unless-stopped`), so
the web tier needs no systemd units and comes back on its own after a reboot.

### 2. Wi-Fi sensor

```bash
cd services/sensor-wifi
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[replay]'
cd ../..
```

The systemd unit runs `.venv/bin/python` directly, so the venv must exist
before the unit starts. Monitor mode is *not* part of install:
the unit's `ExecStartPre=` re-runs `scripts/setup-monitor.sh` on every start,
because monitor mode survives neither a reboot nor a replug.

### 3. SDR sensor

```bash
sudo apt install -y dump1090-mutability
sudo usermod -aG plugdev dump1090      # without this it runs happily with no radio -- see 03-sdr-setup.md
sudo systemctl restart dump1090-mutability

cd services/sensor-sdr
cargo build --release --features rtlsdr
cd ../..
```

**Build with `--features rtlsdr` on a unit that has a radio.** The ADS-B path
does not need it — the `adsb` subcommand consumes dump1090's output and never
opens the device — but the sweep engine and `probe --open` do, and without the
feature they are not merely disabled, they are absent. The binary builds, runs,
serves ADS-B perfectly, and answers `bands` and `sweep` with nothing, so the
Spectrum page reports a unit that cannot sweep and every explanation points at
the radio. That is the failure this line exists to prevent.

The feature links the RTL-SDR Blog fork of librtlsdr, which must already be
built and installed per [03-sdr-setup.md](03-sdr-setup.md); `build.rs` asks
`pkg-config` and falls back to `/usr/local/lib`, or takes `RTLSDR_LIB_DIR` if it
is somewhere else. On a build host with no radio and no librtlsdr, plain
`cargo build --release` is still the right command.

### 4. Systemd units

```bash
sudo ./deploy/systemd/install.sh wlan1
sudo systemctl enable --now classg-sensor-wifi classg-sensor-sdr
```

The installer renders [deploy/systemd](../../deploy/systemd)'s templates
against **this checkout's absolute path** and this interface name, because
systemd will not expand a variable into an `ExecStart` binary path. That has a
consequence for later: the installed units are snapshots, so a change to a
`.service.in` template — or moving the checkout — does nothing until
`install.sh` is re-run.

Both units read `.env` via `EnvironmentFile=`, restart with bounded backoff
(five failures in five minutes, then they stop in `failed` where
`systemctl status` shows it — [roadmap, Milestone 5](../planning/roadmap.md#milestone-5--operational-hardening)),
and the Wi-Fi unit runs as root because AF_PACKET on a monitor interface
requires it.

### 5. Verify

```bash
systemctl list-units 'classg*' 'dump1090*'      # three units, all running
docker ps                                        # classg-ui, classg-api, classg-fusion
curl -s localhost:8081/api/v1/health | jq .status
```

`/health` is the check that matters: every expected sensor listed and
`healthy: true`, not merely processes running. Declare the unit's sensors in
`sensors.expected` (see the [production checklist](00-configuration.md#production-checklist))
so a sensor that never starts shows up as unhealthy instead of not showing up.

## One caveat before trusting the first minutes of data

**The Pi has no RTC.** It boots on `fake-hwclock`'s saved timestamp, systemd
starts the sensors against that wrong clock, and NTP corrects it only once the
network is up — measured on this unit as a 7 h 51 min forward jump about fifty
seconds after boot. Detections stamped in that window carry the wrong time
permanently, and a field unit with no uplink never corrects at all. The full
write-up, including how to spot the jump in the journal, is in
[05-troubleshooting.md](05-troubleshooting.md#timestamps-or-uptime-look-wrong);
if absolute timestamps in the field matter to you, that section's answer is an
RTC module, not software.

## Updating a running unit

On a unit with the deploy agent installed ([10](10-continuous-deployment.md)),
the answer is usually **nothing**: it pulls from `main` on a timer and deploys
any commit whose CI is green. Use `./scripts/pi-autodeploy.sh --once` to make it
happen now, or `--force` to rebuild everything at the current commit.

Updating by hand still works and is sometimes what you want, but know what it
costs. A manual `git pull` leaves the tree current, so the agent's next run sees
`LOCAL == REMOTE`, reports "up to date", and **does not rebuild anything** — the
SDR binary on this unit was two days behind the source that way, through runs
that all called themselves successful. The agent compares artefacts against
their sources now and repairs that, but it does so on its own schedule; if you
pulled by hand, rebuild by hand.

```bash
cd ~/classg && git pull && git submodule update --init --recursive
```

Then rebuild what the pull touched:

| Changed | Do |
|---|---|
| `services/api`, `services/fusion`, `services/ui` | `docker compose --env-file .env -f docker/docker-compose.yml up -d --build api` (or `fusion`, `ui`; `make compose-up` rebuilds whatever changed across all three) |
| `services/sensor-wifi` | `cd services/sensor-wifi && .venv/bin/python -m pip install -e '.[replay]'` then `sudo systemctl restart classg-sensor-wifi`. The pip step only matters when dependencies changed — the unit runs the checkout's source directly — but it is cheap and skipping it is how a dependency bump ships untested |
| `services/sensor-sdr` | `cd services/sensor-sdr && cargo build --release --features rtlsdr` then `sudo systemctl restart classg-sensor-sdr`. **The feature flag is not optional on a unit with a radio** — without it the binary builds and runs and has no sweep engine, so `bands` and `sweep` are simply absent and the Spectrum page reports the unit as unable to sweep. The unit runs `target/release/`, so an un-rebuilt binary keeps running yesterday's code while the source says otherwise |
| `tools/pi-dash` | `cd tools/pi-dash && cargo build --release`. It is a submodule: `git pull` moves the *pointer*, and `git submodule update --init --recursive` is what moves the checkout. A pull without it leaves the pin ahead of the files, and the dashboard keeps running the old build |
| `deploy/systemd/*.service.in` | `sudo ./deploy/systemd/install.sh wlan1 && sudo systemctl restart classg-sensor-wifi classg-sensor-sdr` — the installed units are rendered snapshots |
| `schemas/` | All of the above. The schema is the one contract all four languages share; updating one side of the bus and not the other is a silent wire mismatch |
| `config/defaults.yaml` | Nothing, deliberately: the database is authoritative after first run ([00-configuration.md](00-configuration.md)). Change settings through the API or the UI |

Restarting a sensor mid-flight is safe by design: fusion marks the source
stale, the track coasts, and detections resume when the sensor does
([ADR-0003](../architecture/adr/0003-sensor-process-isolation.md)). Restarting
the api container drops WebSocket clients, which reconnect and refetch — the
UI is built for that.

### If you drive updates over SSH

A non-login SSH command (`ssh pi 'cargo build --release'`) does not read the
login shell's profile, so anything rustup installed into `~/.cargo/bin` is not
on `PATH` — the build fails with `cargo: command not found` while working fine
in an interactive shell, which reads as a broken Pi rather than a missing
profile. Verified on this unit. Either invoke by absolute path
(`~/.cargo/bin/cargo`) or force a login shell (`ssh pi 'bash -lc "cargo build --release"'`).
The same applies to anything else installed by a tool that edits
`~/.bashrc`/`~/.profile` rather than dropping a file in `/etc/profile.d`.

## Watching the unit

- [`tools/pi-dash`](../../scripts/README.md) — live host and radio state in a
  terminal, unprivileged.
- `GET /api/v1/system` — build, runtime config, and host readings, behind the
  UI's Settings → About panel. `GET /api/v1/telemetry` is the same readings
  recorded once a minute (`telemetry.interval`, kept for `retention.telemetry`,
  default 14 days), so "when did the disk start filling" has an answer.
- `GET /metrics` — Prometheus exposition, if something scrapes it.
- **Throttling and undervoltage are host-only.** `vcgencmd` is not available
  inside the api container and this kernel exposes no sysfs equivalent, so
  `/system` lists `throttled` as unavailable by design. On the host:
  `vcgencmd get_throttled` (`0x0` is the only good answer).
- For an unexplained radio dropout, [`scripts/usb-soak.sh`](../../scripts/README.md)
  samples both radios until one lets go.

Reaching the unit from a cloud session is its own document:
[08-cloud-tailscale.md](08-cloud-tailscale.md).

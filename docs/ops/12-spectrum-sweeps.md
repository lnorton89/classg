# Sweeping a band from a containerised API

The Spectrum page measures how much energy is in a band and where. Making that
work on the deployed unit took a host-side agent, and the reason is worth
stating before the instructions.

## Why the API cannot do it

`spectrum.sdr_bin` points at the sensor binary, and the API execs it. That works
when the API runs on the host, and cannot work at all in the layout that
actually exists: the API container has **no sensor binary, no `/dev/bus/usb`
and no librtlsdr** — all three checked absent on the unit. So the setting could
never point at anything real and the page reported "no sweep engine configured"
permanently.

The two ways out were to give the container the binary, the USB device tree and
the library, or to hand the work to something already on the host that has all
three. The first is a privileged container running radio code on behalf of a
web-facing process, which is the opposite of the reasoning that keeps deploys
and repairs out of that container ([10](10-continuous-deployment.md),
[11](11-self-healing.md)). So: the same file exchange those two use, a third
time.

The API writes `spectrum-request.json`; the agent writes
`spectrum-result-<id>.json` back. Nothing else crosses the boundary, and
nothing in the mount grants host control.

## It yields the radio

`dump1090` owns the dongle on a working unit ([ADR-0008](../architecture/adr/0008-adsb-via-dump1090.md))
and a sweep cannot share it. So a sweep **stops dump1090, measures, and starts
it again** — ADS-B is blind for the duration, which for `ism_915` is about four
seconds and for `fpv_1g2` is minutes. The web app says so before the button is
pressed, because the cost belongs to whoever pressed it.

Restoring it is handled in three places, because "the sweep ended" has three
shapes: the sweep returned, systemd stopped the agent mid-measurement, or the
agent was killed outright. Traps cover the first two; the unit's `ExecStopPost`
covers the third, since nothing in a script runs after SIGKILL.

## Installing it

```bash
./scripts/install-sweep-agent.sh
```

It refuses rather than half-installing:

- **no binary, or one built without `--features rtlsdr`** — the sweep engine only
  exists in a build with that feature, and discovering it from the web app is
  worse than discovering it here. Build with
  `cd services/sensor-sdr && cargo build --release --features rtlsdr`.
- **the state directory is not writable by you** — Docker creates a missing bind
  mount as root, so the directory the container made for the agent may not be
  the agent's to write to.
- **the API container cannot write to the state directory** — see below.

It grants exactly two commands passwordless through sudo: stopping and starting
`dump1090-mutability.service`. Nothing else.

## The permission that bites

One directory, two users that share nothing: the agents run on the host as the
operator, the API runs in its container as its own unprivileged user. Getting
this half-right is worse than getting it wrong, and it shipped that way — the
directory was `0755` owned by the operator, so the container could **read** it.

Everything that only reads worked. The band list loaded, the page reported the
sweep agent as available, and the button was offered. The first actual sweep
failed with

```
writing the sweep request: /var/lib/classg/agent-state/spectrum-request.json:
permission denied
```

and the deploy button had been broken the same way since it shipped, unnoticed
because nobody had pressed it.

The fix is a shared **group**, not a shared uid:
[`scripts/agent-state-setup.sh`](../../scripts/agent-state-setup.sh) sets the
directory to `2775` — group-writable, setgid so anything created inside carries
the directory's group whichever side made it — and records its gid in
`docker/.env` as `CLASSG_AGENT_STATE_GID`, which the api service joins through
`group_add`. The container keeps its own uid and gains nothing else.

World-writable would also work and is not on the table: a deploy-request marker
in this directory starts a deploy, so write access to it is a privilege
boundary rather than a convenience.

All three installers run that script, and it **proves the result** by writing a
file from inside the container. Availability needs a read; a sweep needs a
write; nothing short of writing tests the thing that was broken.

## When it does not work

| Symptom | Cause |
|---|---|
| "no sweep agent has run on this unit" | `spectrum-bands.json` is missing — the agent has never started. `systemctl status classg-sweep-agent` |
| "permission denied" writing the request | The group setup above. Re-run `scripts/agent-state-setup.sh` |
| "cannot list bands; is it built with --features rtlsdr?" | The binary predates the `bands` subcommand or lacks the feature |
| The sweep times out | The error names what the exchange directory holds: a request still sitting there means nothing collected it; a result under another id means something answered a sweep nobody was waiting for |
| ADS-B does not come back | `journalctl -t classg-sweep-agent`; the restart is logged. `ExecStopPost` is the backstop |

## The other half of the band

The sweep engine stops at 1.766 GHz ([ADR-0004](../architecture/adr/0004-rtlsdr-scope.md)),
so the Spectrum page has a second source for the bands it cannot reach at all.
It is not a sweep and it is not an FFT — the Wi-Fi adapter cannot produce one.
It is the per-channel counters mac80211 already keeps for its own channel
selection, read with `iw dev wlan1 survey dump`:

| Reading | What it is |
|---|---|
| Busy fraction | Of the time the radio spent on that channel, how much of it the medium was sensed busy |
| Noise | The driver's own noise-floor measurement, in dBm |
| Listening | Which channel the hopper was parked on when the sample was taken |

The counters are **cumulative since the interface came up**, so the sensor
differences them and publishes the window since the last heartbeat. Two
consequences worth knowing before reading the bars:

- **The first heartbeat after a restart shows nothing.** There is no previous
  sample to difference against, and reporting the cumulative counters once would
  draw hours of accumulated busy time as a spike.
- **A channel missing from the list was not measured, not quiet.** Only channels
  the hopper actually visited in that window have any active time, and dwell is
  weighted heavily towards channel 6.

It costs nothing to run. Unlike a sweep it takes no radio away from anything:
the numbers are a by-product of listening, which is why this half of the page
updates itself and has no button. If `iw` is absent or the driver reports no
survey, the panel says the adapter has none rather than drawing an empty band.

One number there is worth an alarm rather than a reading: **transmit time**.
This is a receive-only system on a monitor-mode interface, so the driver's
transmit counter must stay at zero. The panel escalates a non-zero value,
because it means something else is using that adapter — it is the one place the
receive-only constraint can be checked rather than asserted.

## What it deliberately does not do

It does not classify. A peak above the threshold means something is
transmitting; it never means a drone. Telling an ELRS control link from a smart
meter needs cadence analysis this build does not ship, and no line on that chart
should be read as an aircraft.

The occupancy view classifies even less. Most of what it measures is other
people's Wi-Fi, and a busy channel is a busy channel.

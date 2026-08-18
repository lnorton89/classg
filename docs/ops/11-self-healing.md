# Coming back by itself

Two related questions: does everything start after a reboot, and does anything
fix itself when it breaks.

## What already survives a reboot

Most of it does, and this is worth knowing before adding anything:

| Thing | How |
|---|---|
| `classg-sensor-wifi` | systemd unit, `enabled`, `Restart=always`. Its `ExecStartPre` runs `setup-monitor.sh`, so **monitor mode is re-established on every start** rather than assumed — it survives neither a reboot nor a replug |
| `classg-sensor-sdr` | systemd unit, `enabled`, `Restart=always`, ordered `After=dump1090-mutability.service` |
| `dump1090-mutability` | its own service, started by the OS |
| API, UI, fusion | Docker containers with `restart: unless-stopped`, and `docker.service` is `enabled` |

The unit files live in [`deploy/systemd/`](../../deploy/systemd/). They were only
on the Pi until recently, which meant a rebuild would have lost them.

## The gap: `StartLimitBurst`

Both sensor units set this, deliberately:

```ini
StartLimitIntervalSec=300
StartLimitBurst=5
```

The reasoning in the unit file is sound — an unbounded `Restart=always` against a
physically absent adapter is a loop that burns CPU while looking like activity —
and it names what is missing:

> systemd 252 (Bookworm) has no `RestartSteps`/`RestartMaxDelaySec`, so escalating
> backoff is not available here; give up visibly instead of backing off blindly.

Giving up visibly is right. The problem is what happens next: **nothing tries
again, ever.** On a boot where the USB adapter enumerates a few seconds late,
five restarts are spent in twenty-five seconds and the sensor is dead until
somebody signs in and notices.

That is what the watchdog is for. It is the supervised retry systemd 252 cannot
express — not a reason to weaken the units.

## The watchdog

[`scripts/classg-watchdog.sh`](../../scripts/classg-watchdog.sh), on a timer
every two minutes.

```bash
cd ~/classg
./scripts/install-watchdog.sh
```

Each pass checks the API, then each sensor unit, and takes at most one bounded
action per target.

### The ladder

Attempt 1 is immediate; then **5 min, 15 min, 60 min**; then it stops.

```
attempt 1  ->  immediately
attempt 2  ->  after 5 minutes
attempt 3  ->  after 15 minutes
attempt 4  ->  after 60 minutes
           ->  gives up, reports "needs hands"
```

A target that becomes healthy has its history cleared, so a unit that recovers
gets the full ladder next time rather than resuming near the ceiling.

### `reset-failed` is the part that actually works

A unit that exhausted `StartLimitBurst` sits in `failed`, and **`systemctl
restart` on it does nothing at all**. The repair is:

```bash
systemctl reset-failed <unit> && systemctl restart <unit>
```

Missing the first half is the single most confusing way for a watchdog to appear
not to work: it runs, it reports success, and the unit stays dead.

### Three rules it does not break

**A repair must not hide a fault.** Every attempt is recorded and surfaced under
**Admin → Self-repair**. After the ceiling it *stops* and says the unit needs a
person, rather than restarting something broken every two minutes for a week —
which is how a dead adapter becomes a mystery instead of a fault.

**Absent hardware is not a software fault.** If the adapter is not on the USB
bus, restarting a process cannot help. That is reported, and it does **not**
consume an attempt — the ladder is not spent waiting for someone to plug it back
in.

**It never interrupts a measurement.** A capture or sweep in progress postpones
every sensor repair, the same rule the deploy agent follows. A completely dead
API is the exception, because nothing can be measured through one anyway.

### Watching it

```bash
journalctl -t classg-watchdog -f          # what it has done
./scripts/classg-watchdog.sh --dry-run    # what it would do, changing nothing
./scripts/classg-watchdog.sh              # run a pass now
./scripts/classg-watchdog.sh --reset      # forget the escalation history
sudo systemctl disable --now classg-watchdog.timer
```

`--reset` is what to run after fixing something by hand, so the ladder starts
from the top again.

### Privileges

The same narrow sudoers drop-in as the deploy agent: exactly two `systemctl
restart` commands and nothing else. `NOPASSWD` on a broad `systemctl` would make
this timer a general privilege escalation for anyone who can write to the repo.

The API reads the watchdog's state file and has no privileges of its own here —
it is containerised, and giving a web-facing process the ability to restart host
units would make every bug in it a host compromise
([10-continuous-deployment.md](10-continuous-deployment.md) has the same
reasoning for deploys).

## What it deliberately does not do

- **Reflash, reinstall or roll back.** That is the deploy agent's job and it has
  its own gates.
- **Restart a healthy-but-quiet sensor.** A quiet sky is healthy
  ([ADR-0003](../architecture/adr/0003-sensor-process-isolation.md)), and a
  watchdog that restarted on "no detections lately" would restart all night in
  a field with no drones in it.
- **Power-cycle USB.** Tempting, and it fixes some wedges. It also resets the
  radio out from under `dump1090` and can hang the whole bus on a Pi. If that
  becomes necessary it should be a deliberate operator action, not something a
  timer does at 3am.
- **Repair anything more than once per pass.** One action, then wait and look
  again. A pass that fixed three things at once could not tell you which repair
  was the one that mattered.

# Deploying automatically

[09-deployment.md](09-deployment.md) is how to deploy by hand. This is how to
make the unit do it itself when `main` goes green.

**This is opt-in and should stay that way on any unit that matters.** Automatic
deployment to a live detection unit means the unit stops detecting, without
warning, at a moment nobody chose. That is a decision an operator makes on
purpose.

## How it works

A systemd timer on the Pi runs [`scripts/pi-autodeploy.sh`](../../scripts/pi-autodeploy.sh)
every ten minutes. Each run:

1. Fetches `origin/main`. If it matches what is checked out, stop.
2. Refuses if the working tree is dirty — a dirty tree on a field unit is
   someone mid-diagnosis, and `git pull` would clobber it.
3. **Asks GitHub whether CI concluded `success` for that exact commit.** Still
   running, failed, or no runs recorded → leave the unit where it is.
4. Refuses while a capture or a sweep is running.
5. Fast-forwards, rebuilds only what changed, restarts, and waits for
   `/health` to answer.
6. If it does not come back, rolls the checkout back and rebuilds from the
   previous commit.

### Pull, not push

The Pi asks GitHub; GitHub never touches the Pi. That means:

- **No inbound credentials.** GitHub needs no key to this box and this box needs
  no public ingress. A push-based deploy requires one or the other.
- **It catches up.** A unit that was powered off, off the tailnet, or in a field
  with no signal deploys the next time it looks. A webhook fired at an offline
  box is simply lost.
- **It is debuggable where the problem is.** `./scripts/pi-autodeploy.sh --dry-run`
  on the unit tells you what it would do right now.

### The CI gate is the point

It deploys a commit only when the check-runs for that **exact SHA** all
concluded `success`. Not "main is newer" — `main` can be red, and a unit that
deploys red `main` stops detecting for a reason nobody chose.

Anything that is not a clean success leaves the unit alone: still running,
`failure`, `cancelled`, `timed_out`, `action_required`, `stale`, or no runs
recorded yet. Those are listed explicitly rather than negating `success`, so a
conclusion GitHub adds in future fails closed.

If the GitHub API is unreachable the unit **does not** deploy blind. It keeps
running what it has, which is a commit that was green when it landed.

### It will not interrupt a measurement

Before deploying it checks `/captures` and `/spectrum/sweeps` for anything
`running`. Taking the radio away from an operator mid-sweep to install a UI
change is not a trade this gets to make on anyone's behalf.

### Only what changed gets rebuilt

| Changed | Rebuilt |
|---|---|
| `services/api`, `services/fusion`, `services/ui`, `docker` | `docker compose up -d --build` |
| `services/sensor-sdr` | `cargo build --release --features rtlsdr`, then restart the unit |
| `services/sensor-wifi` | `pip install -e .`, then restart the unit |

A release build of the Rust sensor is minutes on a Pi. Spending them to install
a UI change would take ADS-B down for nothing.

## Installing it

```bash
cd ~/classg
git pull
./scripts/install-autodeploy.sh
```

That installs the service and timer, enables the timer, and writes a sudoers
drop-in granting **exactly two commands**:

```
admin ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-sdr.service
admin ALL=(root) NOPASSWD: /usr/bin/systemctl restart classg-sensor-wifi.service
```

Narrow on purpose. `NOPASSWD` on a broad `systemctl` would turn this timer into
a general privilege escalation for anyone who can write to the repo — which,
with auto-deploy running, is anyone who can merge to `main`.

The Docker half needs no sudo because the deploy user is already in the `docker`
group. Note that this is itself root-equivalent on any machine; it is a property
of the existing setup rather than something auto-deploy introduces, but it is
worth knowing when deciding whether to enable this at all.

## From the admin page

The web app shows what this unit is running, whether an update is waiting, what
CI said about it, and the tail of the last agent run — under **Admin →
Deployment**. There is a button to request a deploy.

**The API cannot deploy anything, and is deliberately not able to.** It runs in
a container; giving a web-facing process a way to run `systemctl` on the host
would make every bug in this API a host compromise. So the two talk through
files in a shared directory:

- the agent writes `deploy-state.json` after every run;
- the API reads it, and writes `deploy-requested` when someone presses the
  button;
- the agent consumes that marker on its next tick and deletes it.

The cost is honest latency: **"Deploy now" means "at the next check"**, up to
ten minutes, and the UI says so rather than showing a spinner that implies
otherwise. A requested deploy is still refused if CI is not green or a
measurement is in progress — the button raises a hand, it does not override the
gates.

**There is nothing to configure.** Both sides default to `<repo>/.agent-state`
and agree by construction.

That default is deliberate rather than convenient. Compose runs from `docker/`
and reads `docker/.env` — **not** the repo-root `.env` the systemd units use. A
state directory set in the root `.env` is therefore invisible to the container,
and the mount silently falls back to its own default. That happened on a live
unit: the agents wrote to `~/.local/state/classg`, the API mounted an empty
directory, and the admin page reported "no agent" with everything working
perfectly. One repo-relative default removes the whole class of problem.

Override both together if you must — `CLASSG_DEPLOY_STATE` for the agents,
`CLASSG_AGENT_STATE_DIR` for the Compose mount — remembering that the second one
has to be somewhere Compose can actually see it (`docker/.env`, or the
environment of whoever runs `docker compose`).

`state_age_s` in the response is worth more than `timer_enabled`: a large age
means the agent is not actually running, whatever the flag claims.

## Watching it

```bash
journalctl -t classg-autodeploy -f          # what it has been doing
systemctl list-timers classg-autodeploy     # when it next runs
./scripts/pi-autodeploy.sh --dry-run        # what it would do right now
./scripts/pi-autodeploy.sh                  # do it now
sudo systemctl disable --now classg-autodeploy.timer   # stop
```

Two escape hatches, both loud in the log:

- `--force` deploys even when the SHAs match, for re-running a build.
- `--skip-ci-check` deploys a commit CI has not blessed. For recovering a unit
  when GitHub is unreachable and you have decided the risk yourself.

## What rollback does and does not do

On a failed health check it checks the previous SHA back out and rebuilds the
web tier from it.

**It does not roll back the database.** It deliberately does not try.
`schema.sql` is `CREATE TABLE IF NOT EXISTS` throughout and every column added
so far has been nullable, so an older binary meets a newer schema with extra
columns it ignores. That is what makes rollback safe today.

**A destructive migration — a dropped column, a renamed table, a backfill —
breaks that assumption and must not ship without a real migration story.** If
you are about to write one, this is the paragraph that says why you cannot just
add it.

## Deciding whether to enable it

Reasonable on a bench unit or a spare. On the unit you actually rely on, weigh:

- Every deploy is an outage of a minute or more, and of several minutes when the
  Rust sensor changed.
- Green CI means the tests passed. It does not mean the change works against
  real hardware — CI has no radio, no adapter and no sky, and the traps in
  [CLAUDE.md](../../CLAUDE.md) are mostly the ones only hardware finds.
- Rollback handles "the API did not come back". It does not handle "the API came
  back and quietly detects nothing", which is the failure mode that matters most
  here and the one no automated check on this unit can see.

A defensible middle: enable it on a spare unit, watch what lands, and deploy the
one you rely on by hand.

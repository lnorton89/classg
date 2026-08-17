# Reaching the Pi from a cloud session

[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
runs in a container in someone else's datacentre. It gets a fresh clone of this
repository and nothing else — no route to your bench, no idea the Pi exists.
This document sets up a Tailscale uplink so a cloud session can reach `pisdr`
the way a laptop on your tailnet does: `ssh`, `curl` against the API on `:8081`,
`journalctl` on a wedged sensor.

The work is done by [`.claude/hooks/session-start.sh`](../../.claude/hooks/session-start.sh),
a `SessionStart` hook that runs before the session begins.

**This is an operator convenience, not part of the detection path.** No service
in `services/` knows about it, nothing here transmits RF, and a container
without a tailnet still runs every test suite. It exists so you can drive real
hardware from a session that would otherwise be typing blind.

## What the container's network actually allows

Both of these were measured from inside a live session, not assumed, and both
have consequences you will notice:

**Outbound UDP is dropped entirely.** `tailscale netcheck` reports `UDP: false`.
There is no NAT traversal and no direct peer connection — every packet to the Pi
relays through a Tailscale DERP server over TCP 443. Expect **130–180 ms
round-trip** and relay-grade throughput. `tailscale ping` says so plainly:

```
pong from pisdr (100.125.115.93) via DERP(sea) in 137ms
direct connection not established
```

That is fine for SSH, the API, and log tailing. It is the wrong pipe for bulk
transfer — do not pull PCAPs or SDR captures across it. Copy those to the Pi's
own storage and work on them there, or fetch them over your LAN.

**All TLS is intercepted.** The egress gateway re-terminates TLS and reissues
certificates under an internal CA, including on connections that bypass
`HTTPS_PROXY`. Tailscale is unbothered because its control protocol carries its
own Noise encryption *inside* the TLS session, so the gateway sees ciphertext
either way — but it is the reason this needed testing rather than assuming.

## Setup

### 1. Mint a tagged, ephemeral, reusable auth key

In the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys),
generate an auth key with all four of these:

| Setting | Why |
|---|---|
| **Reusable** | Every session is a new node. A single-use key works exactly once. |
| **Ephemeral** | The container is discarded without logging out. Ephemeral nodes are reaped automatically instead of leaving one dead `claude-cloud-classg` per session in your machine list. |
| **Pre-approved** | Otherwise every session waits on a manual approval you are not there to give. |
| **Tagged** `tag:claude-cloud` | The node joins as a tagged device rather than as you, so it gets only what the ACL below grants — not your full tailnet. |

### 2. Restrict the tag to the Pi

A disposable container in a third-party datacentre should not hold a key to
everything. In your [ACL policy](https://login.tailscale.com/admin/acls), give
the tag exactly the ports you need:

```jsonc
{
  "tagOwners": {
    "tag:claude-cloud": ["autogroup:admin"],
  },
  "acls": [
    {
      "action": "accept",
      "src":    ["tag:claude-cloud"],
      "dst":    ["pisdr:22,8081"],   // SSH and the ClassG API. Nothing else.
    },
  ],
}
```

The hook also brings the node up with `--shields-up`, which drops all inbound
connections to the container. It dials the Pi; nothing needs to dial it back.

### 3. Add the key to the environment

Put the key in your Claude Code environment settings as a **secret** environment
variable named `TS_AUTHKEY`. Do not commit it, and do not paste it into a
session transcript — a key that reaches a transcript should be revoked.

Rotate it on whatever schedule you rotate anything else; the hook fails loudly
and harmlessly when it expires (see below).

## Using it

The hook exports two variables into the session:

| Variable | Example |
|---|---|
| `CLASSG_PI_IP` | `100.125.115.93` |
| `CLASSG_PI_API` | `http://100.125.115.93:8081` |

```bash
curl -s "$CLASSG_PI_API/api/v1/health" | jq
curl -s "$CLASSG_PI_API/api/v1/sensors" | jq
ssh "pi@$CLASSG_PI_IP"
```

Note that `:8081` serves **only** the API, at `/api/v1` — the Pi runs with
`CLASSG_UI_DIR=off`, so a bare `GET /` there returns a 404 explaining exactly
that. It is not a sign anything is broken.

MagicDNS is deliberately **off** (`--accept-dns=false`): it would rewrite
`/etc/resolv.conf`, and the container's DNS is wired to a proxy the rest of the
session depends on. The Pi is resolved from the peer list instead, which is why
you get an IP in a variable rather than a name.

## When it does not work

The hook never fails a session. A container with no tailnet still runs the test
suites, so every failure path prints a reason and exits 0. Read the
`[tailscale]` lines at session start:

| Message | Meaning |
|---|---|
| `TS_AUTHKEY is not set` | No key in the environment. Everything else still works; you just have no Pi. |
| `tailscale up failed (expired, already-used, or untagged auth key?)` | Mint a new key. A non-reusable key that worked yesterday will do this today. |
| `no tailnet peer named 'pisdr'` | The Pi is powered off, or off the tailnet. The message lists the peers it did see. |
| `is listed but did not answer a ping` | The control plane still has a stale record of a node that has since gone away. |
| `not root` / `/dev/net/tun is missing` | The container cannot create a TUN device. Nothing to be done from inside the repository. |

If the Pi is renamed in Tailscale, set `CLASSG_PI_TAILSCALE_NAME` rather than
editing the hook.

## One thing worth deciding deliberately

This uplink lets detection data — including `operator.lat/lon`, which is a real
person's ground position ([ADR-0006](../architecture/adr/0006-operator-location-retention.md))
— be pulled from the Pi into a cloud session and into a transcript. Nothing
does that on its own; the hook only opens a route. But "nothing detected leaves
the unit" ([external data](07-external-data.md)) stops being automatically true
the moment you `curl` a tracks endpoint from a datacentre. Keep the ACL narrow,
and be as deliberate about what you copy out as you would be about what you
publish.

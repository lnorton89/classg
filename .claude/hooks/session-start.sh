#!/usr/bin/env bash
# Join a Claude Code on the web container to the operator's tailnet, so a cloud
# session can reach the Pi (`pisdr`) the same way a laptop on the tailnet would.
#
# Why this exists: cloud sessions run in an ephemeral container that is
# reclaimed after inactivity. Nothing survives -- not the Tailscale node key,
# not the installed binaries -- so joining the tailnet has to happen from
# scratch on every session or not at all. Doing it by hand means pasting an
# interactive auth URL into a browser every time, which nobody keeps up.
#
# The container's egress is unusual in two ways that shaped this script; both
# are measured, not assumed (see docs/ops/08-cloud-tailscale.md):
#
#   - Outbound UDP is dropped entirely. `netcheck` reports UDP: false, so
#     there is no NAT traversal and no direct peer connection. Every packet to
#     the Pi relays through a DERP server over TCP 443. It works; it is slow.
#   - All TLS is intercepted by an egress gateway that reissues certificates
#     under its own CA. Tailscale survives this because its control protocol
#     carries its own Noise encryption inside the TLS session -- interception
#     sees ciphertext either way.
#
# This never fails a session. A container with no tailnet is a container that
# can still run the test suites, so every failure path here exits 0 with a
# note rather than blocking startup on a network that may simply be down.

set -uo pipefail

TS_VERSION="1.102.2"
TS_SHA256_amd64="ad2cde12f8de95f7b93a1e0401e652291c603d42b9d60a33fb1741eb38ab04d8"
TS_SHA256_arm64="2b64e9ade7e73034b5ec9e9bcd537f5ddd14ae3abb435e57e929e7486ae42660"

# The Pi's Tailscale machine name. Override if the node is renamed.
PI_NAME="${CLASSG_PI_TAILSCALE_NAME:-pisdr}"
TS_HOSTNAME="${CLASSG_TS_HOSTNAME:-claude-cloud-classg}"

note() { echo "[tailscale] $*"; }

# A missing tailnet degrades to "no Pi", not "no session" -- ADR-0003's rule for
# sensors applies just as well to this.
bail() { note "$*"; note "continuing without the tailnet; see docs/ops/08-cloud-tailscale.md"; exit 0; }

# Local checkouts have their own route to the Pi and their own tailnet login.
# Only the disposable cloud container needs this.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

if [ -z "${TS_AUTHKEY:-}" ]; then
    note "TS_AUTHKEY is not set -- skipping tailnet join"
    note "add it as a secret environment variable to connect cloud sessions to the Pi"
    note "setup: docs/ops/08-cloud-tailscale.md"
    exit 0
fi

[ "$(id -u)" = "0" ] || bail "not root, cannot create a TUN device"
[ -c /dev/net/tun ] || bail "/dev/net/tun is missing, cannot create a TUN device"

case "$(uname -m)" in
    x86_64)  TS_ARCH="amd64"; TS_SHA256="$TS_SHA256_amd64" ;;
    aarch64) TS_ARCH="arm64"; TS_SHA256="$TS_SHA256_arm64" ;;
    *)       bail "unsupported architecture $(uname -m)" ;;
esac

# ---------------------------------------------------------------- install

# The container image is cached after this hook completes, so a second session
# on a warm image skips the 37 MB download entirely.
if ! command -v tailscaled >/dev/null 2>&1 ||
   ! tailscale version 2>/dev/null | head -1 | grep -qx "$TS_VERSION"; then
    note "installing tailscale $TS_VERSION ($TS_ARCH)"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT

    TARBALL="tailscale_${TS_VERSION}_${TS_ARCH}.tgz"
    if ! curl -sSL --max-time 300 -o "$TMP/$TARBALL" \
         "https://pkgs.tailscale.com/stable/$TARBALL"; then
        bail "download failed"
    fi

    # Pinned hash, because this installs a binary that gets CAP_NET_ADMIN and a
    # credential. An unverified download here is the weakest link in the chain.
    if ! echo "$TS_SHA256  $TMP/$TARBALL" | sha256sum -c --status -; then
        bail "checksum mismatch on $TARBALL -- refusing to install"
    fi

    tar xzf "$TMP/$TARBALL" -C "$TMP" || bail "tarball did not extract"
    install -m755 "$TMP/tailscale_${TS_VERSION}_${TS_ARCH}/tailscale" \
                  "$TMP/tailscale_${TS_VERSION}_${TS_ARCH}/tailscaled" \
                  /usr/local/bin/ || bail "install failed"
fi

# ---------------------------------------------------------------- daemon

mkdir -p /var/lib/tailscale /var/run/tailscale

# Default socket and state paths, so plain `tailscale status` works in the
# session without anyone having to remember a --socket flag.
if ! tailscale status >/dev/null 2>&1 && ! pgrep -x tailscaled >/dev/null 2>&1; then
    note "starting tailscaled"
    # setsid detaches from the hook's process group: the daemon has to outlive
    # this script for the rest of the session to have a tailnet at all.
    setsid nohup tailscaled \
        --state=/var/lib/tailscale/tailscaled.state \
        --statedir=/var/lib/tailscale \
        --socket=/var/run/tailscale/tailscaled.sock \
        --tun=tailscale0 \
        >/var/log/tailscaled.log 2>&1 < /dev/null &
    disown 2>/dev/null || true

    for _ in $(seq 1 30); do
        tailscale status >/dev/null 2>&1 && break
        # "Logged out" is still a live daemon answering the socket.
        tailscale status 2>&1 | grep -q "Logged out" && break
        sleep 1
    done
fi

# ---------------------------------------------------------------- join

# Ask the daemon for its state rather than pattern-matching the human-readable
# status table. A warm container starts tailscaled against state already on
# disk and reconnects on its own, but that takes a few seconds -- and an
# earlier version of this script read the table mid-reconnect, concluded it was
# logged out, and re-ran `tailscale up`. That forces a needless re-registration
# and, with a single-use key, burns the key on a node that was already joined.
backend_state() {
    tailscale status --json 2>/dev/null |
        sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' | head -1
}

STATE=""
for _ in $(seq 1 30); do
    STATE="$(backend_state)"
    [ "$STATE" = "Running" ] && break
    # Terminal states: waiting longer will not change them, only `up` will.
    case "$STATE" in NeedsLogin|NeedsMachineAuth|Stopped) break ;; esac
    sleep 1
done

if [ "$STATE" = "Running" ]; then
    note "already connected as $TS_HOSTNAME"
else
    note "authenticating to the tailnet as $TS_HOSTNAME"
    # --accept-dns=false: MagicDNS would rewrite /etc/resolv.conf, and this
    # container's DNS is wired to a proxy that the rest of the session depends
    # on. The Pi is resolved from `tailscale status` below instead.
    # --shields-up: nothing needs to open a connection *to* a disposable cloud
    # container. It dials the Pi, never the reverse.
    if ! timeout 120 tailscale up \
        --auth-key="${TS_AUTHKEY}" \
        --hostname="$TS_HOSTNAME" \
        --accept-dns=false \
        --shields-up \
        >/dev/null 2>&1; then
        bail "tailscale up failed (expired, already-used, or untagged auth key?)"
    fi

    [ "$(backend_state)" = "Running" ] ||
        bail "tailscale up succeeded but the backend is $(backend_state)"
fi

SELF_IP="$(tailscale ip -4 2>/dev/null | head -1)"
[ -n "$SELF_IP" ] || bail "joined but no tailnet address was assigned"
note "this container is $SELF_IP ($TS_HOSTNAME)"

# ---------------------------------------------------------------- locate Pi

# Resolved from the peer list rather than DNS, since MagicDNS is off above.
PI_IP="$(tailscale status 2>/dev/null |
         awk -v n="$PI_NAME" '$2 == n && $1 ~ /^100\./ { print $1; exit }')"

if [ -z "$PI_IP" ]; then
    note "no tailnet peer named '$PI_NAME' -- is the Pi powered on and joined?"
    note "peers: $(tailscale status 2>/dev/null | awk '$1 ~ /^100\./ { print $2 }' | tr '\n' ' ')"
    exit 0
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    {
        echo "export CLASSG_PI_IP=\"$PI_IP\""
        echo "export CLASSG_PI_API=\"http://$PI_IP:8081\""
    } >> "$CLAUDE_ENV_FILE"
fi

note "$PI_NAME is $PI_IP  (\$CLASSG_PI_IP, API at \$CLASSG_PI_API)"

# Reachability is worth one round trip: the peer can be listed and still be
# unreachable if it went offline between the control plane's last update and
# now. Relayed latency also tells you what kind of link you have.
if PING="$(timeout 20 tailscale ping --c 1 --until-direct=false "$PI_IP" 2>&1 | head -1)"; then
    note "$PING"
else
    note "$PI_NAME is listed but did not answer a ping -- it may be offline"
fi

exit 0

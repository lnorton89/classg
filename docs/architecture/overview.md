# Architecture overview

## Principles

1. **Sensors are isolated processes.** USB radios disappear, drivers wedge, firmware crashes.
   A sensor failure must degrade the system, never stop it.
2. **One contract, four languages.** JSON Schema in `schemas/` is normative; every service
   validates against it.
3. **Parsers are pure functions.** Bytes in, structs out, no I/O. Exhaustively testable
   against a capture corpus.
4. **Fusion owns all correlation.** Sensors report what they saw. They never guess about
   identity, tracks, or confidence.
5. **Receive only.** No component may transmit. See
   [legal-and-ethics.md](../research/06-legal-and-ethics.md).

## Component diagram

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  sensor-wifi │  │  sensor-sdr  │  │  sensor-ble  │
│   (Python)   │  │    (Rust)    │  │   (Python)   │
│              │  │              │  │              │
│ AWUS036AXML  │  │  RTL-SDR V4  │  │  nRF52840    │
│ monitor mode │  │  IQ + FFT    │  │  Sniffle     │
│ 802.11 parse │  │  energy/     │  │  BT4/BT5     │
│ ODID + DJI   │  │  cadence     │  │  ODID        │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────┬────────┴─────────────────┘
                │  ZeroMQ PUB/SUB · tcp://127.0.0.1:5556
                │  topic: detection.<class>
                ▼
        ┌───────────────────┐
        │      fusion       │  Go
        │                   │
        │ · dedup by serial │
        │ · track lifecycle │
        │ · confidence      │
        │ · ADS-B suppress  │
        └─────────┬─────────┘
                  │ track.* on tcp://127.0.0.1:5557
        ┌─────────┴─────────┐
        ▼                   ▼
  ┌───────────┐      ┌─────────────┐
  │    api    │ Go   │   storage   │  libSQL / Turso
  │ REST + WS │◄─────┤  + WAL      │
  │ + GraphQL │      └─────────────┘
  └──┬─────┬──┘
     │     │ files in .agent-state/    the API runs in a container and
     │     ▼                           cannot run anything on the host
     │  ┌──────────────────────────────────────────┐
     │  │  host agents          systemd, on the Pi │
     │  │  · pi-autodeploy    CI-gated pull deploy │
     │  │  · classg-watchdog  bounded self-repair  │
     │  │  · classg-sweep-agent  borrows the radio │
     │  └──────────────────────────────────────────┘
     │ :8081
     ▼
  ┌───────────┐
  │    ui     │  Vite + MapLibre
  └───────────┘
```

The three host agents are not part of the detection path, and deliberately do
not talk to the API over HTTP. They exchange **files** in one directory: the API
writes a request marker, an agent picks it up on its own schedule and writes its
state back. That is what lets a web-facing process ask for a deploy, a repair or
a sweep without ever being able to run anything on the host —
[10](../ops/10-continuous-deployment.md), [11](../ops/11-self-healing.md),
[12](../ops/12-spectrum-sweeps.md).

## Why these boundaries

**sensor-wifi in Python** — this is where protocol churn lives. DJI ships firmware that moves
field offsets; Remote ID has version variants; new vendor IEs appear. Iteration speed beats
raw throughput at ~1 Hz beacon rates. Scapy and the pcap ecosystem are here.

**sensor-sdr in Rust** — 2.4 MSPS of complex samples is 4.8 M float pairs/sec, continuous,
while running FFTs and sweeping the tuner. This needs predictable performance and no GC pauses
on a Pi. Rust also gives clean failure semantics when the USB device vanishes mid-read.

**fusion + api in Go** — concurrent state management over many tracks with timers and
expiry, plus a WebSocket fan-out. Go's concurrency model fits exactly, and a single static
binary is a genuine operational advantage on a Pi.

**ui in Vite + MapLibre** — MapLibre supports offline tiles, which matters for a field
deployment with no internet.

Full rationale: [ADR-0001](adr/0001-language-split.md).

---

## Channel strategy

**The core problem, now measured.** The design assumed ~1 Hz beacons, which would make uniform
hopping across 13 channels a coin flip. The first real capture measured the DJI Mini 5 Pro at
**~4.17 Hz** (240 ms median), which makes a 400 ms dwell catch a beacon ~81% of the time
instead of ~33%.

The hopper stays as designed. The rate is a property of one aircraft and firmware, not of the
standard — F3411 only mandates 1 Hz, so a different drone can drop straight back into the hard
regime. Weighted dwell is what absorbs that, and it now has measured evidence behind its
primary-channel weighting rather than a guess. See
[01-rf-landscape.md](../research/01-rf-landscape.md#the-dwell-time-problem--measured-and-smaller-than-assumed).

**Approach — weighted dwell.** Allocate time proportional to the prior probability of Remote
ID appearing on each channel:

| Tier | Channels | Share | Rationale |
|---|---|---|---|
| Primary | 2.4 GHz ch **6** | 40% | Where DJI Wi-Fi Remote ID is most commonly observed |
| Secondary | 2.4 GHz ch 1, 11 | 30% | Other common non-overlapping choices |
| Sweep | 2.4 GHz ch 2–5, 7–10, 12–13 | 15% | Catch non-standard configurations |
| 5 GHz | UNII-1/3 subset | 15% | 5 GHz Remote ID; region-dependent |

Configured in `services/sensor-wifi/config/channels.yaml`, not hardcoded. That file is the
plan for a receiver working alone. The two-radio unit splits it — see **Two receivers** below —
and falls back to it whenever a receiver finds itself on its own.

**Adaptive escalation.** On any drone-class detection, immediately **lock dwell to that
channel** for a configurable hold (default 30 s) to maximise track continuity, then resume the
weighted plan. Tracking a detected aircraft matters more than discovering a second one.

The lock is not absolute. Every Nth dwell (`--escalation-scan-every`, default 4) goes back to
the weighted sweep, drawn from every channel *except* the locked one. Without that reservation
the trade above stops being a trade: a drone transmitting continuously refreshes the hold
forever, and on 2026-08-17 one held ch6 for a 2 m 45 s flight during which the radio visited no
other channel at all — a second aircraft anywhere else would have been invisible for the
duration. The reservation costs ~9% of listening time at the default 3× escalated dwell. Watch
`scan_dwells` against `escalations` in the efficiency report; flat while escalations climb
means the lock is absolute again.

**Measure it.** The hopper must emit `hop_dwell_ms`, `beacons_seen_per_channel`, and
`estimated_miss_rate` as metrics. This is a tuning problem with a measurable objective, and it
is the one area where the survey found no published prior work
([05-prior-art.md](../research/05-prior-art.md)). Treat it as a first-class experiment, not a
constant to guess.

### Two receivers

The unit now carries two, and the split is a config change rather than a rewrite as intended —
but **not** the split this section originally predicted. Parking one radio on ch 6 permanently
was the first implementation and it was wrong: nothing else transmits on ch 6 at this site, so
the parked receiver logged 0 frames across 116,788 dwells, which is indistinguishable from a
dead antenna. A receiver with no proof of life is not a receiver.

What runs instead:

| Receiver | Plan | Shape |
|---|---|---|
| `wifi-0` (ALFA, mt7921u) | `channels-primary.yaml` | ch 6 at ~83% of dwells, 1 and 11 for proof of life |
| `wifi-1` (TP-Link, rtl8852au) | `channels-sweep.yaml` | everything else, 2.4 and 5 GHz, ch 6 deliberately absent |

Together they partition the spectrum. **Neither is safe alone** — the primary has no 5 GHz at
all and the companion never visits ch 6 — so each looks for the other's interface at startup and
widens to `channels.yaml` if it is missing. A declared receiver that never reports makes
`/health` degraded rather than "not fitted", unless the survivor says it widened.

**Coordination (opt-in, unmeasured).** An escalated receiver suspends its own sweep for the
duration of the hold. With `--peer-coordination` the *other* receiver widens to cover discovery
while that lasts, reading peer activity off the `receivers[]` array on fusion's existing track
stream. [ADR-0010](adr/0010-receivers-subscribe-for-coordination.md) records the decision, its
limits, and the fact that the size of the win has not been measured against real hardware.

**Per-radio tuning.** The two are different chipsets behind different drivers, so retune cost is
measured per receiver and reported as `hop_latency_ms` rather than assumed. It was a hardcoded
140 ms — taken on the ALFA and applied to both — which made `listening_fraction` on the TP-Link
a number about the wrong hardware.

---

## Detection → Track lifecycle

```
  Detection (sensor)          Fusion                    Track
  ─────────────────           ──────                    ─────
  serial=ABC, rssi=-70  ──►  match by serial?  ──►  existing track: update
  mac=aa:bb:.., odid    ──►  else match by MAC ──►  new track: state=TENTATIVE
                             else new track
                                  │
                                  ├─ 2+ detections, ≥2 s apart,  ──► CONFIRMED
                                  │  AND identified (below)
                                  ├─ no detection for 30 s      ──► COASTING
                                  └─ no detection for 300 s     ──► CLOSED
```

**Corroborating evidence never confirms on its own.** Classes C (Wi-Fi OUI/SSID), D (ADS-B)
and H (GNSS interference) can raise confidence but cannot move a track past TENTATIVE, however
many detections arrive or how long they span. An OUI names whoever built the radio, not what is
flying it, and a beacon repeating at 10 Hz clears "2+ detections, ≥2 s apart" in a second.

Such a track is still a track: it keeps its MAC index, so a Basic ID arriving later promotes it
in place with its history intact. `corroboratingOnlyClasses` in `services/fusion/track.go` is
the list; the UI mirrors it to shelve those contacts under **Unidentified RF** rather than
counting them as aircraft.

**Identity precedence** — most to least trustworthy:

1. Remote ID / DroneID **serial number** — cryptographically meaningless but protocol-stable
2. Transmitter **MAC address** — stable per session, defeated by randomisation
3. **Position + time** proximity — for correlating across sensors
4. **RF signature** — control-link cadence; weakest, use only to corroborate

A track promoted from MAC-keyed to serial-keyed **retains its history**. This matters:
sensors often see a Location message before a Basic ID.

**Only 1 and 2 are implemented, and only when they co-occur.** Fusion joins two identities when
a *single detection* carries both — that is the whole association mechanism. There is no
MAC-to-MAC linking and no position/time gating, so one airframe presenting two radios that
never share a frame is necessarily two tracks. That is not a tuning failure and no threshold
fixes it.

This is routine for a DJI: on 2026-08-17 the aircraft's Remote ID beacon (ch6, `8c:1e:d9`, a
Unigroup chipset) and its 5.8 GHz access point (ch149, `0c:9a:e6`, DJI's own OUI) were recorded
as separate tracks 4 s apart, with no overlapping frame to link them. Level 3 would be the fix,
but it needs co-observation the escalation lock was preventing — which is why the scan
reservation above is a prerequisite for it rather than an unrelated tweak. Until then, keep
unidentified contacts visibly separate from aircraft rather than merging on vendor alone: two
DJI drones flying near each other must not collapse into one track.

---

## ADS-B false-positive suppression

`sensor-sdr` decodes ADS-B via `dump1090`. Fusion uses it two ways:

1. **Context** — display manned traffic alongside drone tracks.
2. **Suppression** — a helicopter overhead produces broadband RF that can trip energy
   detectors on multiple bands. If a manned aircraft is within a configurable radius and
   altitude window, downweight energy-only detections (Classes E/F) during that window.

Never suppress Class A/B detections. A decoded Remote ID serial is not a helicopter.

**Network ADS-B fallback.** Units without an SDR, or with SDR ground-level terrain shadow,
can enable `CLASSG_FUSION_NET_ADSB=true` to pull manned traffic from a community feed
(`api.adsb.lol` by default) instead of `dump1090`. It publishes as `sensor_kind: "net"`
(default `sensor_id: net-adsb-0`) and feeds the same suppression path — Class D still never
contributes confidence. Off by default: a detector that silently phones home is a different
product from one that doesn't. See `services/fusion/netadsb.go`.

---

## Failure modes designed for

| Failure | Detection | Response |
|---|---|---|
| USB adapter disappears | Sensor read error | Sensor exits non-zero; supervisor restarts with backoff; fusion marks source stale |
| Driver wedges (mt7921u) | No frames for N seconds while interface is up | Sensor self-diagnoses, attempts interface reset, escalates to unhealthy |
| RTL-SDR read timeout | libusb error | Reopen device; after 3 failures, report unhealthy and stop claiming coverage |
| Fusion crash | Supervisor | Restart; tracks rebuild from live detections. **Track state is intentionally not persisted** — stale tracks are worse than no tracks |
| Bus backpressure | ZMQ HWM reached | Sensors drop oldest detections and increment a counter. Never block a capture loop on a slow consumer |
| USB power brownout | Multiple sensors fail together | Health endpoint surfaces the correlation; documented in troubleshooting |

The health endpoint must distinguish **"no drones present"** from **"sensor is broken."**
A drone detector that silently stops detecting is worse than one that is obviously offline —
this is the single most important operational property of the system.

---

## Deployment

**Development** — Docker Compose, with the caveat that USB passthrough for both radios
requires `--privileged` or careful device mapping, plus host network mode for monitor-mode
interfaces. Containerising sensors is often more friction than it is worth; see
[docker/README.md](../../docker/README.md).

**Deployed layout on the Pi:**
- Sensors as **systemd units** on the host, with direct hardware access
  ([deploy/systemd](../../deploy/systemd))
- Fusion, API, and UI in **containers**, with fusion listening on the published
  bus port and the host sensors connecting outward to it

That split puts containers where they help (dependency isolation for the web stack) and keeps
them away from where they hurt (USB device and network-namespace handling). Fusion has no
hardware coupling, so it lives with the web tier rather than on the host. Install, run, and
update procedure: [docs/ops/09-deployment.md](../ops/09-deployment.md).

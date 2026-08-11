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
  └─────┬─────┘      └─────────────┘
        │ :8081
        ▼
  ┌───────────┐
  │    ui     │  Vite + MapLibre
  └───────────┘
```

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

Configured in `services/sensor-wifi/config/channels.yaml`, not hardcoded.

**Adaptive escalation.** On any drone-class detection, immediately **lock dwell to that
channel** for a configurable hold (default 30 s) to maximise track continuity, then resume the
weighted plan. Tracking a detected aircraft matters more than discovering a second one.

**Measure it.** The hopper must emit `hop_dwell_ms`, `beacons_seen_per_channel`, and
`estimated_miss_rate` as metrics. This is a tuning problem with a measurable objective, and it
is the one area where the survey found no published prior work
([05-prior-art.md](../research/05-prior-art.md)). Treat it as a first-class experiment, not a
constant to guess.

**If a second Wi-Fi adapter is ever added,** the correct split is one radio parked on ch 6
permanently and one sweeping — which eliminates the tradeoff entirely. Design the hopper so
this is a config change, not a rewrite.

---

## Detection → Track lifecycle

```
  Detection (sensor)          Fusion                    Track
  ─────────────────           ──────                    ─────
  serial=ABC, rssi=-70  ──►  match by serial?  ──►  existing track: update
  mac=aa:bb:.., odid    ──►  else match by MAC ──►  new track: state=TENTATIVE
                             else new track
                                  │
                                  ├─ 2+ detections, ≥2 s apart ──► CONFIRMED
                                  ├─ no detection for 30 s      ──► COASTING
                                  └─ no detection for 300 s     ──► CLOSED
```

**Identity precedence** — most to least trustworthy:

1. Remote ID / DroneID **serial number** — cryptographically meaningless but protocol-stable
2. Transmitter **MAC address** — stable per session, defeated by randomisation
3. **Position + time** proximity — for correlating across sensors
4. **RF signature** — control-link cadence; weakest, use only to corroborate

A track promoted from MAC-keyed to serial-keyed **retains its history**. This matters:
sensors often see a Location message before a Basic ID.

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

**Recommended layout on the Pi:**
- Sensors and fusion as **systemd units** on the host, with direct hardware access
- API, UI, and storage in **containers**

That split puts containers where they help (dependency isolation for the web stack) and keeps
them away from where they hurt (USB device and network-namespace handling).

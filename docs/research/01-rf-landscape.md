# RF landscape: what a drone actually emits

A drone is not one emitter. It is a small constellation of them, and each has a different
detection profile. Understanding which emissions exist is what separates a system that
detects *compliant* drones from one that detects *drones*.

## The five emission classes

```
                     ┌───────────────────────────────────────────┐
                     │              AIRCRAFT                     │
                     ├───────────────────────────────────────────┤
   ① Remote ID  ◄────┤ broadcast, ~1 Hz, standardised, plaintext │
   ② Downlink   ◄────┤ video + telemetry to controller           │
   ③ Uplink     ─────┤► control from controller (TX is on ground)│
   ④ Wi-Fi AP   ◄────┤ some drones run an AP for the phone app   │
   ⑤ Incidental ◄────┤ GNSS reradiation, ESC noise, motor EMI    │
                     └───────────────────────────────────────────┘
```

**① Remote ID** is the easiest and the least reliable. Easy because it is designed to be
received — plaintext, standardised, ~1 Hz, containing serial number and GPS position.
Unreliable because it depends entirely on the operator's compliance. A drone with Remote ID
disabled, a home-built airframe, or anything predating the mandate emits nothing here.

**② Downlink** is the hardest to fake and therefore the most trustworthy. The aircraft must
transmit video and telemetry to fly. This is always present on any camera drone. For DJI it is
OcuSync at 2.4/5.8 GHz; for analog FPV it is 1.2/5.8 GHz FM video.

**③ Uplink** originates from the *controller on the ground*, not the aircraft. Detecting it
localises the **operator**, which is often more actionable than localising the aircraft.
ELRS/Crossfire at 868/915 MHz is squarely in RTL-SDR range.

**④ Wi-Fi AP mode** applies to cheaper drones and to DJI models in Wi-Fi mode. The SSID and
BSSID OUI are a reliable fingerprint even with no Remote ID.

**⑤ Incidental** emissions are research-grade; not in scope.

---

## Band plan

### 433 MHz ISM (433.05 – 434.79 MHz)
- Legacy MAVLink telemetry (3DR-style radios), ELRS 433 in some regions
- Narrow, low duty cycle, FHSS
- **RTL-SDR: in range, easy.** 2.4 MHz covers the entire band in one tune.

### 868 MHz (EU) / 902–928 MHz (US) ISM
The most productive SDR band for drone detection.

| System | Detail |
|---|---|
| TBS Crossfire | 868 MHz EU / 915 MHz US, FHSS, distinctive ~50 Hz packet rate |
| ExpressLRS 900 | 50/100/200 Hz packet rates, LoRa modulation, very regular |
| RFD900 | Long-range MAVLink telemetry, higher power |
| DragonLink | Legacy long-range UHF control |

These are **control uplinks** — the transmitter is the pilot's controller. Crucially, aircraft
using them are typically FPV/long-range builds that broadcast **no Remote ID at all**. This is
the blind spot the Wi-Fi sensor cannot cover.

**Detection approach:** sweep 902–928 MHz in 2.4 MHz steps (11 tunes), compute per-bin power,
and look for the regular burst cadence of FHSS control links. Fixed packet rates (50/100/200 Hz)
produce a highly characteristic time-domain signature that separates them from LoRaWAN,
Meshtastic, smart meters, and other 915 MHz clutter.

**Expect heavy clutter.** 915 MHz in a residential area contains smart meters, Meshtastic,
Zigbee bridges, and more. Cadence analysis — not raw energy — is what makes this usable.

### 978 MHz — UAT
US ADS-B for general aviation below 18,000 ft. `dump978`.

### 1090 MHz — ADS-B 1090ES
All transponder-equipped manned aircraft. `dump1090`.

Two distinct uses:
1. **Airspace context** — an operator sees what else is flying nearby.
2. **False-positive suppression** — a helicopter overhead lights up multiple bands. Knowing a
   manned aircraft is at that bearing lets fusion downweight ambiguous RF hits.

### 1.2 / 1.3 GHz — analog FPV video (1080 – 1360 MHz)
Long-range analog FPV downlink. Wideband FM, continuous while flying, often high power.
Continuous transmission makes it easy to spot with an energy detector; the sustained
occupancy of a ~20 MHz slice is itself the signature.

**Legally sensitive:** much of this range overlaps aeronautical radionavigation, and most
1.2 GHz FPV use is unlicensed and illegal. Detecting it is entirely legal.

### 1575.42 MHz — GNSS L1
Not a drone emission — a drone *dependency*. Monitoring the noise floor here detects jamming
or interference, which is both a drone-failure predictor and a threat indicator in its own
right. Low priority, cheap to add once the SDR sweeper exists.

### 2.4 GHz ISM (2400 – 2483.5 MHz) — **beyond RTL-SDR**
- DJI OcuSync 2/3/4 downlink+uplink
- ELRS 2.4, FrSky, DSMX control
- Wi-Fi Remote ID beacons ← **AWUS036AXML territory**
- Bluetooth Remote ID advertising ← needs the nRF52840

### 5.8 GHz (5645 – 5945 MHz) — **beyond RTL-SDR**
- DJI OcuSync high-rate downlink
- Analog FPV race bands (A/B/E/F/R, 25/200/600 mW)
- Wi-Fi Remote ID on 5 GHz channels ← AWUS036AXML

---

## Where Remote ID lives, precisely

For the Wi-Fi Beacon transport, this determines channel-hopping strategy — the single
highest-leverage tuning decision in the whole system.

| Transport | Channels | Rate |
|---|---|---|
| Wi-Fi Beacon 2.4 GHz | Commonly **ch 6 (2437 MHz)**; ch 1/11 also seen | ~1 Hz |
| Wi-Fi Beacon 5 GHz | Varies by region and model | ~1 Hz |
| Wi-Fi NAN | 2.4 ch 6, 5 ch 44/149 | ~1 Hz |
| BT4 legacy adv | 2402 / 2426 / 2480 MHz | ~1 Hz |
| BT5 Coded PHY | Primary adv channels + secondary data channels | ~1 Hz |

**The dwell-time problem — measured, and smaller than assumed.**

The design was built on "beacons arrive at roughly 1 Hz", taken from the standard's *minimum*
rate. The first real capture says otherwise:

| Measured, DJI Mini 5 Pro, 2026-08-10 | |
|---|---|
| Median beacon interval | **240 ms (~4.17 Hz)** |
| 174 of 175 intervals | under 700 ms |
| Sustained average over 58 s | 3.0 beacons/s |
| Pack contents | 3 messages (Basic ID + Location + System), 83-byte IE |

That is 3–4× more forgiving than designed for. Treating beacon arrivals as Poisson with a
400 ms dwell:

| Beacon rate | Expected beacons per 400 ms dwell | P(catch ≥1) |
|---|---|---|
| 1 Hz (assumed) | 0.4 | 33% |
| **4.17 Hz (measured)** | **1.67** | **81%** |

So a full 13-channel sweep at 400 ms dwell — a ~7 s cycle including hop latency — still catches
the aircraft on nearly every visit. **The weighted-dwell machinery was solving a harder problem
than actually exists.**

Keep it anyway: it costs nothing, it is measured rather than assumed, and the rate is a
property of *this* aircraft and firmware. A different drone emitting at the standard's 1 Hz
minimum puts you straight back in the hard regime, and the weighting is what absorbs that.
See [overview.md#channel-strategy](../architecture/overview.md#channel-strategy).

---

## Physics of detection range

Free-space path loss sets the ceiling. At 2.4 GHz:

```
FSPL(dB) = 20·log₁₀(d_km) + 20·log₁₀(f_MHz) + 32.44
```

| Distance | FSPL @ 2.4 GHz |
|---|---|
| 100 m | 80 dB |
| 500 m | 94 dB |
| 1 km | 100 dB |
| 5 km | 114 dB |

A 20 dBm Remote ID beacon received at −90 dBm sensitivity gives a 110 dB link budget →
roughly 3 km line-of-sight in ideal conditions. Real-world reported figures:

- Wi-Fi Remote ID: **700 m+** open field, substantially less in urban clutter
- BT5 Coded PHY S8: **500 m – 1+ km**

Source: [WarDragon detection capabilities](https://github.com/alphafox02/WarDragon/blob/main/docs/software/detection-capabilities.md)

Two consequences worth internalising:

- **Height beats gain.** A drone at 100 m AGL is line-of-sight to a much larger area than
  ground clutter suggests. Antenna placement dominates every software optimisation.
- **RSSI is not range.** Do not build range estimation on RSSI without per-model calibration;
  antenna orientation on a manoeuvring aircraft swings RSSI by 20 dB. Use it for *coarse*
  proximity bucketing only.

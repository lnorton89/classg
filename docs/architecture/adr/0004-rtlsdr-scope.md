# ADR-0004: The RTL-SDR does not detect DJI drones — scope it honestly

**Status:** Accepted · **Date:** 2026-08-10

## Context

The obvious expectation for an SDR in a drone-detection project is that it detects drones —
specifically, the DJI drone available for testing. It cannot, for two independent reasons:

1. **Frequency.** RTL-SDR V4 ceiling is **1.766 GHz**. DJI OcuSync operates at 2.4/5.8 GHz.
2. **Bandwidth.** OcuSync DroneID is ~10 MHz wide and requires 15.36 MSPS to demodulate. The
   RTL-SDR provides 2.4 MHz stable.

A downconverter fixes (1) and not (2), yielding an energy detector in the noisiest band in
consumer RF. That is worse than useless: it produces confident-looking detections triggered by
Wi-Fi, Bluetooth, and microwave ovens.

Full analysis: [02-hardware-capabilities.md](../../research/02-hardware-capabilities.md)

## Decision

`sensor-sdr` is scoped to **sub-2 GHz signals only**, and its role is explicitly *not* "detect
the DJI":

| Priority | Target | Value |
|---|---|---|
| 1 | ADS-B 1090 MHz (`dump1090`) | Airspace context + false-positive suppression |
| 2 | 902–928 / 868 / 433 MHz control links | **Detects non-Remote-ID aircraft the Wi-Fi sensor is structurally blind to** |
| 3 | 1.2/1.3 GHz analog FPV downlink | Long-range analog FPV |
| 4 | GNSS L1 noise floor | Interference indicator |

Priority 2 is the strategic justification for the SDR. Aircraft flying ELRS or Crossfire are
exactly the ones that broadcast no Remote ID — so the SDR is not a redundant second look at
compliant drones, it is the only look at non-compliant ones.

## Consequences

- **The README states the limitation first**, before any capability claim. Discovering this
  after buying hardware or writing DSP code is the expensive failure mode.
- `sensor-sdr` is a **device-agnostic process**. It talks to a `SdrSource` trait, with
  `RtlSdrSource` as the first implementation. Adding a HackRF later is a new implementation,
  not a rewrite — this keeps OcuSync decode reachable without designing for it now.
- **No 2.4 GHz downconverter** will be added. Recorded here so the idea does not resurface.
- Class E/F detections carry **low confidence weights** (0.30 / 0.25) in fusion. Energy and
  cadence detection in shared ISM bands is inherently ambiguous, and the scoring must say so
  rather than presenting inference as observation.

## If wideband is ever added

The upgrade is a **HackRF One** (20 MHz), **AntSDR E200**, or **USRP B200** — 15.36 MSPS at
2.4/5.8 GHz, which makes OcuSync DroneID decode reachable via `proto17/dji_droneid`. Worth it
only if decoding DJI's proprietary link is a goal in itself; for compliant aircraft, Wi-Fi
Remote ID already delivers serial number and position at a fraction of the cost and
complexity.

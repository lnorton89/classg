# ADR-0003: One process per radio

**Status:** Accepted · **Date:** 2026-08-10

## Context

The research turned up specific, documented instability in this exact hardware:

- `mt7921u` **stops working** if active monitor mode is set ([mt76 #839](https://github.com/openwrt/mt76/issues/839))
- MT7921 Bluetooth and Wi-Fi on the same USB device cause **sporadic Wi-Fi crashes** on kernels 6.6+
- RTL-SDR USB reads fail and need device reopen
- Two high-draw USB radios on a Pi cause **power brownouts** that drop adapters

These are not hypotheticals. A monolithic process sharing an address space across radios means
any one of them takes down all detection.

## Decision

**One OS process per radio.** Each supervised independently by systemd with restart backoff.
Communication only via ZMQ ([ADR-0002](0002-message-bus-zeromq.md)) — no shared memory, no
FFI, no in-process plugins.

```
classg-sensor-wifi.service   Restart=always  RestartSec=5   → AWUS036AXML
classg-sensor-sdr.service    Restart=always  RestartSec=5   → RTL-SDR V4
classg-sensor-ble.service    Restart=always  RestartSec=5   → nRF52840 (optional)
classg-fusion.service        Restart=always  RestartSec=2
classg-api.service           Restart=always  RestartSec=2
```

## Consequences

**Health reporting becomes mandatory, not optional.** With independent processes, a dead
sensor is silent rather than obvious. Every sensor must emit a heartbeat on the bus at a fixed
interval regardless of whether it detected anything, and fusion must mark a source stale when
heartbeats stop.

This produces the property that matters most operationally:

> The system can distinguish **"no drones are flying"** from **"the Wi-Fi sensor is wedged."**

A drone detector that fails silently is worse than one that is visibly offline, because it
manufactures false confidence. Encoding this in the architecture rather than in a monitoring
afterthought is the point of this ADR.

**Restart backoff must be bounded.** A sensor whose USB device is physically unplugged will
restart-loop forever. Cap at 5 rapid restarts, then back off to 60 s and report unhealthy
rather than thrashing.

**Cost:** more moving parts, more systemd units, more to deploy. Accepted — the failure
isolation is worth it given documented driver instability.

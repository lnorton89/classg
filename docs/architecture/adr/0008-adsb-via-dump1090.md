# ADR-0008: dump1090 owns the radio, and we consume its decoded output

**Status:** Accepted · **Date:** 2026-08-11

## Context

Milestone 2 needs manned traffic on the map for airspace context and to suppress
false positives. That means ADS-B at 1090 MHz, and it raises two questions that
have to be answered before any code is written, because each one is expensive to
reverse.

**Who owns the dongle?** ADS-B is a continuous listen on a single frequency.
Milestone 3's sweep engine retunes across 902–928 MHz and needs the same tuner.
One RTL-SDR cannot do both: `rtlsdr_open` is exclusive, and even if it were
time-sliced, every second spent at 915 MHz is a second of aircraft not heard.
The band plan already overlaps — `fpv_1g2` spans 1080–1360 MHz, which contains
1090.

**How much of Mode S do we decode ourselves?** The sensor could take raw frames
and demodulate, or take a decoder's output.

That second question was settled empirically on 2026-08-11. An 80-second capture
through `rtl_adsb` produced **147 frames, of which 12 survived the Mode S CRC** —
one real aircraft (ICAO A1878A) and roughly 135 pieces of noise that a naive
reader would have accepted as aircraft. Frames were captured from inside a steel
storage container, so reception was heavily attenuated; the ratio is worse than a
normal site would see, but the failure mode is not.

The decoding work is also not trivial. Position arrives in Compact Position
Reporting form, which requires pairing even and odd frames within a time and
distance window and is a well-known source of subtly wrong positions. A
drone-detection system that plots manned traffic in the wrong place is worse than
one that plots none.

## Decision

**`dump1090` owns the SDR for Milestone 2.** `sensor-sdr` runs it (or attaches to
an already-running instance) and does not open the device itself while it lives.

**We consume decoded output, not raw frames.** Specifically the SBS-1 / BaseStation
stream on TCP 30003, not the raw AVR stream on 30002. dump1090 has already done
CRC validation, Mode S decode and CPR position resolution; all three are places
where a reimplementation would be silently wrong rather than visibly broken, and
none of them is where this project adds value.

**Class D detections are only ever emitted from CRC-validated messages.** This is
a consequence of the above rather than separate work, and it is recorded because
it is the invariant that matters: without it, ~90% of what reaches fusion in a
poor-reception environment is fabricated aircraft. Combined with the pre-fix
behaviour of `TrackStore` — which minted a track per identity-less detection —
that would have produced a map of hundreds of phantom contacts with no single
obvious cause.

## Consequences

- **Milestone 3 needs a second dongle, or an explicit time-slicing design.** It
  cannot assume the radio is free. This is the main cost of this decision and it
  is accepted: ADS-B is continuous by nature and there is no version of sharing
  one tuner that does not degrade both jobs. A second RTL-SDR is ~£30 and removes
  the problem entirely.
- `sensor-sdr` gains a process dependency it must supervise. A dump1090 that dies
  is a degraded sensor with an operator-visible reason, not a crash — ADR-0003.
- The sensor must heartbeat whether or not aircraft are in range. A quiet sky and
  a dead dump1090 produce identical detection streams, and only the heartbeat
  distinguishes them.
- We inherit dump1090's decisions, including its CRC error tolerance. Its default
  single-bit correction is acceptable; anything more permissive is not.
- If ADS-B is ever sourced from a network feed rather than a local radio, that is
  a different sensor with different failure modes — an uplink rather than an
  antenna — and none of this ADR applies to it.

## Alternatives considered

**Own Mode S demodulator in Rust.** Rejected. CPR position decoding is the entire
difficulty and reimplementing it buys nothing; the existing implementation is
mature and widely validated against real traffic.

**Raw AVR stream (port 30002) with our own CRC.** Rejected for the same reason —
it still leaves CPR to us. A CRC check alone is easy, as the Python probe on
2026-08-11 showed; it is the position maths that is not.

**Time-slice one dongle between ADS-B and the sweep.** Deferred to Milestone 3
rather than rejected outright, but it degrades both roles and should be measured
against the cost of a second dongle before being adopted.

# ASTM F3411 Remote ID — wire format

Normative sources:
[opendroneid/opendroneid-core-c](https://github.com/opendroneid/opendroneid-core-c) ·
ASTM F3411-22a · ASD-STAN prEN 4709-002 (EU)

`opendroneid-core-c` is the reference implementation. Where this document and that library
disagree, **the library is right** — treat this as an orientation guide, and validate the
parser against real captures before trusting any field.

## Transport layers

| Transport | Carrier | Notes |
|---|---|---|
| Bluetooth 4 Legacy | AD type Service Data, UUID `0xFFFA` | 25-byte payload, one message per advert |
| Bluetooth 5 Extended | LE Coded PHY S2/S8 | Message Pack, long range, needs a capable receiver |
| Wi-Fi NAN | Service Discovery Frame | Needs NAN cluster tracking; harder |
| **Wi-Fi Beacon** | **Vendor IE 221, OUI `FA:0B:BC`, type `0x0D`** | **ClassG's primary path** |

## Wi-Fi Beacon encapsulation

```
802.11 Beacon frame
└── Tagged parameters
    └── Tag 221 (Vendor Specific)
        ├── OUI            FA:0B:BC        (3 bytes, ASD-STAN / ODID)
        ├── Vendor type    0x0D            (1 byte)
        ├── Send counter   0x00-0xFF       (1 byte, increments per transmission)
        └── Message Pack   (variable)
```

## Message structure

Every message is exactly **25 bytes**: 1 header byte + 24 bytes of payload.

```
Header byte:  ┌───────────────┬───────────────┐
              │ msg type (4b) │ version (4b)  │
              └───────────────┴───────────────┘
                high nibble     low nibble
```

| Type | Name | Content |
|---|---|---|
| `0x0` | Basic ID | ID type, UA type, 20-byte UAS ID (serial / registration / UUID) |
| `0x1` | Location/Vector | Lat, lon, altitudes, speed, track, vertical speed, timestamp, accuracies |
| `0x2` | Authentication | Signature pages (rarely populated in the wild) |
| `0x3` | Self ID | 23-char free-text description of the operation |
| `0x4` | System | Operator lat/lon, area info, UA classification, operator altitude |
| `0x5` | Operator ID | 20-char operator registration ID |
| `0xF` | Message Pack | Container: msg size (1) + msg qty (1) + N × 25 bytes |

**Message Pack is the common case on Wi-Fi Beacon** — a single beacon typically carries Basic
ID + Location + System + Operator ID together. Parse the pack first, then recurse.

### Basic ID (type 0x0) payload

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | high nibble = ID type, low nibble = UA type |
| 1 | 20 | UAS ID, ASCII, null-padded |
| 21 | 3 | reserved |

**ID type:** `0` none · `1` serial number (ANSI/CTA-2063-A) · `2` CAA registration ·
`3` UTM assigned UUID · `4` specific session ID

**UA type:** `0` undeclared · `1` aeroplane · `2` **multirotor** · `3` gyroplane ·
`4` hybrid VTOL · `5` ornithopter · `6` glider · `7` kite · `8` free balloon ·
`9` captive balloon · `10` airship · `11` free-fall parachute · `12` rocket ·
`13` tethered powered · `14` ground obstacle

For serial-number IDs the ANSI/CTA-2063-A format is: 4-char manufacturer code, 1-char length
code, then the manufacturer serial. **The manufacturer code is a reliable vendor fingerprint**
even when nothing else identifies the aircraft.

### Location/Vector (type 0x1) payload — the important one

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 1 | Status + flags | bits 7-4 status, bit 2 height type, bit 1 E/W segment, bit 0 speed multiplier |
| 1 | 1 | Track direction | `dir` if E/W segment = 0, else `dir + 180` (degrees) |
| 2 | 1 | Speed | mult=0: `raw × 0.25` · mult=1: `raw × 0.75 + 63.75` (m/s) |
| 3 | 1 | Vertical speed | `int8 × 0.5` (m/s, positive = up) |
| 4 | 4 | **Latitude** | `int32 LE ÷ 1e7` (degrees) |
| 8 | 4 | **Longitude** | `int32 LE ÷ 1e7` (degrees) |
| 12 | 2 | Pressure altitude | `uint16 LE × 0.5 − 1000` (m) |
| 14 | 2 | Geodetic altitude | same encoding |
| 16 | 2 | Height above takeoff/ground | same encoding |
| 18 | 1 | Accuracy | high nibble vertical, low nibble horizontal |
| 19 | 1 | Accuracy | high nibble baro, low nibble speed |
| 20 | 2 | Timestamp | `uint16 LE × 0.1` s since the top of the hour |
| 22 | 1 | Timestamp accuracy | low nibble |
| 23 | 1 | reserved | |

**Operational status** (high nibble of byte 0): `0` undeclared · `1` ground · `2` airborne ·
`3` emergency · `4` remote-ID system failure

The `0x0` sentinel for "unknown" appears in several fields; a lat/lon of exactly `0,0` means
*no GPS fix*, not the Gulf of Guinea. Filter it.

### System (type 0x4) payload

Carries **operator location** — often the most operationally significant field in the entire
standard, and the reason Remote ID was controversial. Also carries UA classification (EU
categories) and operating-area geometry for swarm operations.

### Operator ID (type 0x5) payload

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Operator ID type (`0` = CAA-issued) |
| 1 | 20 | Operator ID, ASCII, null-padded |

---

## Implementation strategy

1. **Parse the pack, then dispatch.** Type `0xF` first, then each 25-byte member.
2. **Validate the version nibble.** Versions 0–2 exist; reject unknown versions loudly rather
   than misparsing.
3. **Never trust length.** Malformed and truncated IEs are common. Bounds-check every read;
   a drone-detection service that crashes on a malformed beacon is a denial-of-service target.
4. **Messages arrive independently.** Basic ID and Location may come in different beacons.
   Correlate by transmitter MAC, then promote to serial number once Basic ID is seen. This
   correlation belongs in `fusion`, not the parser.
5. **The parser must be pure.** Bytes in, dataclass out, no I/O. It is the one component that
   can and should be exhaustively unit-tested against captured frames.

## Known real-world deviations

- DJI's Wi-Fi Beacon Remote ID has shipped firmware revisions with **inconsistent altitude and
  location reporting**. Do not assume standards compliance implies correctness — validate
  against your own drone's telemetry.
- Some implementations omit System messages entirely, so operator location is unavailable.
- Send counter does not always increment monotonically; don't use it for dedup.

## Test vectors

Populate `services/sensor-wifi/tests/vectors/` with real captures from your DJI plus synthetic
frames generated by `opendroneid-core-c`'s test utilities. Every field in the tables above
should have at least one vector, including the boundary cases: lat/lon = 0, speed multiplier
transitions, negative vertical speed, and altitude below the −1000 m offset.

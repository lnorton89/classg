# DJI DroneID — the two protocols with the same name

"DroneID" refers to **two entirely different systems**. Conflating them is the most common
mistake in this space, and it directly determines what your hardware can do.

| | **Wi-Fi DroneID** | **OcuSync DroneID** |
|---|---|---|
| Carrier | 802.11 beacon, vendor IE 221 | Proprietary LTE-derived OFDM burst |
| OUI / marker | `26:37:12` | Zadoff-Chu sync sequences |
| Frequency | 2.4 / 5 GHz Wi-Fi channels | 2.4 / 5.8 GHz, non-Wi-Fi |
| Bandwidth | Standard 802.11 | ~10 MHz (15.36 MHz with guards) |
| Cadence | ~1 Hz beacon | burst every ~600 ms |
| **Receivable with AWUS036AXML** | **✅ yes** | ❌ no |
| **Receivable with RTL-SDR V4** | ❌ no | ❌ no |
| Hardware needed | The adapter you own | HackRF / AntSDR / USRP / BladeRF |

**ClassG targets Wi-Fi DroneID.** OcuSync DroneID is documented here for completeness and to
justify the hardware boundary, not because it is in scope.

---

## Wi-Fi DroneID (in scope)

Broadcast in the vendor-specific IE of 802.11 beacon frames under OUI `26:37:12`. Unencrypted.
Reference parsers:
[Kismet `dot11_ie_221_dji_droneid`](https://github.com/kismetwireless/kismet/blob/master/dot11_parsers/dot11_ie_221_dji_droneid.h) ·
[bkerler/DroneID](https://github.com/bkerler/DroneID) ·
[Bender & Reith, *DJI drone IDs are not encrypted*](https://arxiv.org/pdf/2207.10795)

### Frame layout

```
Tag 221 (Vendor Specific)
├── OUI          26:37:12
├── unk / vendor byte
├── subcommand   0x10 or 0x11
└── payload
```

Two subcommands:

- **`0x10` — flight telemetry.** Serial number, aircraft position/altitude/velocity/attitude,
  home point, **and operator (app) position**.
- **`0x11` — flight purpose.** Operator-entered free text describing the flight.

### Subcommand 0x10 payload (approximate layout)

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | version | |
| 1 | 2 | sequence number | LE |
| 3 | 2 | state info | bitfield: GPS valid, in-air, motors on, home set |
| 5 | 16 | **serial number** | ASCII, null-padded — the primary identity key |
| 21 | 4 | longitude | int32 LE, radians × 1e7 |
| 25 | 4 | latitude | int32 LE, radians × 1e7 |
| 29 | 2 | altitude | int16 LE |
| 31 | 2 | height (AGL) | int16 LE |
| 33 | 2 | velocity north | int16 LE |
| 35 | 2 | velocity east | int16 LE |
| 37 | 2 | velocity up | int16 LE |
| 39 | 2 | pitch | int16 LE |
| 41 | 2 | roll | int16 LE |
| 43 | 2 | yaw | int16 LE |
| 45 | 4 | **operator latitude** | int32 LE |
| 49 | 4 | **operator longitude** | int32 LE |
| 53 | 4 | home longitude | int32 LE |
| 57 | 4 | home latitude | int32 LE |
| 61 | 1 | product type | model enum |
| 62 | 1 | UUID length | |
| 63 | n | UUID | |

> ⚠️ **This layout is field-order-accurate but not offset-guaranteed across firmware
> revisions.** DJI has shipped variants. Treat the table as a starting hypothesis and confirm
> against your own captures before relying on any offset. The parser in
> `services/sensor-wifi/classg_wifi/parsers/dji.py` is written defensively for this reason.

### Coordinate conversion

DJI encodes lat/lon in **radians scaled by 1e7**, not degrees:

```
degrees = raw / 1e7 × (180 / π)
        = raw / 174_532.925...
```

Sanity check during bring-up: fly the drone and confirm the decoded position lands on your
actual location. If you get a value ~57× too small, you forgot the radian conversion. If you
get something in the Gulf of Guinea, you're reading zeros.

### Fields needing calibration against your drone

These are the ones where public documentation disagrees and firmware varies. **Resolve them
empirically** — this is exactly what your DJI is for:

| Field | Candidate units | How to resolve |
|---|---|---|
| `altitude` | m, or dm (÷10) | Fly to a known altitude, compare to the DJI app |
| `height` | m, or dm | Hover at 10 m; if you decode 100, it's decimetres |
| `velocity_*` | cm/s, dm/s, or m/s | Fly a straight line at a known speed |
| `pitch/roll/yaw` | deci-degrees, or 0.01° | Yaw to a known heading, compare |

Write the answers into `docs/ops/04-calibration.md` and encode them as constants in the parser
with a comment naming the drone model and firmware version they were derived from.

### Operational significance

The `0x10` payload contains the **operator's position**. This is why DJI DroneID has been
studied as a privacy and targeting concern, and it is a genuine capability of any receiver
that parses these frames — including this one. Handle it accordingly; see
[06-legal-and-ethics.md](06-legal-and-ethics.md).

---

## OcuSync DroneID (out of scope — reference only)

- LTE-derived OFDM with Zadoff-Chu sequences for synchronisation
- 9 OFDM symbols per burst; two symbols use a long cyclic prefix, the rest short
- ~10 MHz occupied, 15.36 MHz with guard carriers
- Burst roughly every 600 ms
- Capture requires **15.36 MSPS or 30.72 MSPS** — only sample rates dividing evenly by the
  15 kHz LTE subcarrier spacing into a power-of-two FFT are usable

Prior work: [proto17/dji_droneid](https://github.com/proto17/dji_droneid) ·
[anarkiwi/samples2djidroneid](https://github.com/anarkiwi/samples2djidroneid) ·
[NDSS 2023 paper](https://www.ndss-symposium.org/wp-content/uploads/2023-217-paper.pdf)

Neither of your radios can capture this. Revisit only if a wideband SDR is added; the design
in [ADR-0004](../architecture/adr/0004-rtlsdr-scope.md) keeps the door open by making
`sensor-sdr` a pluggable process rather than a hardcoded RTL-SDR dependency.

---

## Wi-Fi OUI fingerprinting (cheap and useful)

Independent of any Remote ID payload, drone Wi-Fi interfaces have identifiable MAC OUIs and
SSID patterns. This catches drones that broadcast no Remote ID at all — worth implementing
because it costs almost nothing on top of the frames you are already capturing.

| Vendor | Signals |
|---|---|
| DJI | OUI `60:60:1F`, `34:D2:62`, `48:1C:B9`; SSIDs `Mavic-*`, `Phantom-*`, `Tello-*` |
| Parrot | OUI `90:03:B7`, `00:12:1C`; SSIDs `Bebop-*`, `ANAFI-*` |
| Autel | SSIDs `Autel-*`, `EVO-*` |
| Skydio | SSIDs `Skydio-*` |

Maintain this as **data, not code** — `services/sensor-wifi/data/oui_fingerprints.yaml` — so
it can be updated without a release. Treat OUI matches as **low-confidence** evidence: MAC
randomisation and OUI reassignment both cause false positives. Fusion should score an
OUI-only hit far below a Remote ID hit; see
[data-model.md](../architecture/data-model.md#confidence-scoring).

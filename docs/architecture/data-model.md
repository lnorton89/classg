# Data model

Two core types. `schemas/*.schema.json` is normative — this document explains the reasoning.

## Detection

What a sensor observed, once. Immutable. Never contains inference about identity or threat.

```jsonc
{
  "schema_version": "1.0",
  "detection_id": "01J8XQ...",        // ULID — sortable by time
  "ts": "2026-08-10T14:23:11.482Z",   // RFC3339, UTC, millisecond precision
  "sensor_id": "wifi-0",
  "sensor_kind": "wifi",              // wifi | sdr | ble
  "detection_class": "A",             // see README class table

  "rf": {
    "freq_hz": 2437000000,
    "channel": 6,
    "rssi_dbm": -68,
    "bandwidth_hz": 20000000
  },

  "identity": {
    "serial": "1581F5FMD234A00A1234",  // null if unknown
    "mac": "60:60:1f:aa:bb:cc",
    "id_type": "serial_ansi_cta_2063",
    "ua_type": "multirotor",
    "operator_id": null,
    "vendor_hint": "dji"
  },

  "position": {                        // aircraft; null if not reported
    "lat": 47.3769, "lon": 8.5417,
    "alt_geodetic_m": 512.5,
    "alt_pressure_m": 510.0,
    "height_agl_m": 87.5,
    "h_accuracy_m": 3.0, "v_accuracy_m": 5.0
  },

  "kinematics": {
    "speed_mps": 12.25,
    "track_deg": 143.0,
    "vertical_speed_mps": -1.5
  },

  "operator": {                        // SENSITIVE — see retention
    "lat": 47.3750, "lon": 8.5400, "alt_m": 430.0
  },

  "raw": {
    "encoding": "base64",
    "bytes": "...",                    // the vendor IE, for replay/debug
    "parser": "odid/1.2"
  }
}
```

### Design decisions

**Nullable everything except `ts`, `sensor_id`, `detection_class`.** A Location message with
no preceding Basic ID has position but no serial. Modelling this as optional at the schema
level prevents sensors from inventing placeholder identities.

**`raw` is retained.** Field offsets vary across DJI firmware. Keeping the source bytes means
a parser bug can be fixed and historical detections re-decoded, rather than the data being
lost. Costs a few hundred bytes per detection; worth it during a project whose parsers are
explicitly unvalidated.

**No confidence field on Detection.** Sensors report observations. Confidence is a fusion
concern — a single detection has no context to judge itself.

**No threat/priority field anywhere.** That is a policy decision for whoever operates the
system, and encoding it into the data model bakes in assumptions that won't survive contact
with a real deployment.

---

## Track

Fusion's stateful correlation of detections over time. Mutable.

```jsonc
{
  "schema_version": "1.0",
  "track_id": "01J8XR...",
  "state": "CONFIRMED",               // TENTATIVE | CONFIRMED | COASTING | CLOSED
  "first_seen": "2026-08-10T14:23:11.482Z",
  "last_seen": "2026-08-10T14:31:02.117Z",
  "detection_count": 471,

  "identity": {
    "serial": "1581F5FMD234A00A1234",
    "macs": ["60:60:1f:aa:bb:cc"],     // may accumulate under randomisation
    "vendor": "dji",
    "model_hint": "Mini 3 Pro",
    "operator_id": null
  },

  "confidence": 0.94,
  "evidence": [
    {"class": "A", "sensor_kind": "wifi", "weight": 0.6, "count": 402},
    {"class": "B", "sensor_kind": "wifi", "weight": 0.5, "count": 398},
    {"class": "C", "sensor_kind": "wifi", "weight": 0.1, "count": 471}
  ],

  "current": { /* latest position + kinematics */ },
  "history": [ /* ring buffer, configurable depth */ ],

  "suppression": {
    "adsb_correlated": false,
    "adsb_icao": null
  }
}
```

### Confidence scoring

Confidence answers **"is this really a drone?"** — not "is it a threat?" and not "is the
position accurate."

Evidence combines via noisy-OR, which has the right shape: independent weak signals accumulate,
but never quite reach certainty, and no single class can be gamed into a false confirm.

```
confidence = 1 − Π(1 − wᵢ)     over distinct evidence classes present
```

| Class | Weight | Justification |
|---|---|---|
| A — F3411 Remote ID | 0.60 | Standards-compliant, self-identifying, structured |
| B — DJI DroneID | 0.50 | Vendor-specific but unambiguous |
| G — BLE Remote ID | 0.60 | Same payload semantics as A |
| E — control-link cadence | 0.30 | Strong but inferential; ISM clutter is real |
| F — analog FPV video | 0.25 | Distinctive, but shares bands with other services |
| C — Wi-Fi OUI/SSID | 0.10 | Weakest; MAC randomisation and OUI reuse cause errors |
| D — ADS-B | — | Never contributes; used only for suppression |

Deliberate properties:

- **OUI alone tops out at 0.10.** A DJI-OUI MAC with no Remote ID is a hint, not a detection.
  This is where naive detectors generate most of their false positives.
- **A + B together ≈ 0.80**, and adding C reaches 0.82. Correlated evidence from the same
  sensor cannot manufacture certainty.
- **Weights are configuration**, in `services/fusion/config/weights.yaml`. They are calibrated
  hypotheses, not physical constants — revise them against measured false-positive rates once
  the test corpus exists.

**Independence is assumed and is partly false** — A and B both come from the same Wi-Fi radio
and the same aircraft, so they aren't independent evidence in a strict Bayesian sense. Noisy-OR
is chosen for being transparent and tunable rather than correct. Revisit if measured
calibration turns out poor.

---

## Retention

| Data | Default | Rationale |
|---|---|---|
| Detections (full, incl. `raw`) | 7 days | Enough for parser debugging and incident review |
| Tracks (no operator location) | 90 days | Trend and pattern analysis |
| **Operator location** | **24 hours** | Sensitive; see [legal-and-ethics.md](../research/06-legal-and-ethics.md#operator-location-is-the-sharp-edge) |
| Raw PCAP / IQ captures | manual only | Never automatic; capture deliberately, delete when done |

Operator location lives in a **separate store** with its own retention job, so it can be
purged, redacted, or disabled independently of everything else. The API omits it unless
`CLASSG_EXPOSE_OPERATOR_LOCATION=true` is explicitly set.

Since storage moved to libSQL with optional cloud sync ([ADR-0006](adr/0006-storage-turso-libsql.md)),
that separation is also a **privacy boundary**: operator positions are excluded from sync
unconditionally and never leave the device. There is no flag to enable it.

---

## Schema versioning

`schema_version` is on every message. Rules:

- Additive changes (new optional field) → minor bump, consumers ignore unknown fields
- Breaking changes (removal, retype, semantic change) → major bump, and fusion must accept
  both versions for one release cycle

Sensors and fusion may be upgraded independently on a running Pi. Assume they will be.

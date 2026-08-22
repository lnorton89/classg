/* eslint-disable */
/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Derived from the normative JSON Schemas in `schemas/`.
 * Regenerate with: npm run gen:types
 */

/**
 * A single observation by a single sensor. Immutable. Contains no inference about identity, tracking, or threat - those are fusion concerns.
 */
export interface Detection {
  schema_version: '1.0'
  /**
   * ULID - lexicographically sortable by creation time
   */
  detection_id: string
  /**
   * RFC3339 UTC, millisecond precision
   */
  ts: string
  sensor_id: string
  /**
   * The physical thing that made the observation. 'net' is a network feed rather than a radio: someone else's receiver, relayed to us. It is deliberately its own kind and not 'sdr' -- a network feed has different failure modes (an uplink, not an antenna), different latency, and cannot be trusted to have seen anything at this location.
   */
  sensor_kind: 'wifi' | 'sdr' | 'ble' | 'net'
  /**
   * A=F3411 WiFi RID, B=DJI DroneID, C=OUI/SSID fingerprint, D=ADS-B, E=control link, F=analog FPV, G=BLE RID, H=GNSS interference
   */
  detection_class: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'
  rf?: {
    freq_hz?: number
    channel?: number | null
    rssi_dbm?: number | null
    bandwidth_hz?: number | null
    snr_db?: number | null
  }
  identity?: {
    serial?: string | null
    mac?: string | null
    id_type?: 'none' | 'serial_ansi_cta_2063' | 'caa_registration' | 'utm_uuid' | 'specific_session' | null
    ua_type?:
      | 'undeclared'
      | 'aeroplane'
      | 'multirotor'
      | 'gyroplane'
      | 'hybrid_vtol'
      | 'ornithopter'
      | 'glider'
      | 'kite'
      | 'free_balloon'
      | 'captive_balloon'
      | 'airship'
      | 'parachute'
      | 'rocket'
      | 'tethered_powered'
      | 'ground_obstacle'
      | 'other'
      | null
    operator_id?: string | null
    self_id?: string | null
    vendor_hint?: string | null
  }
  /**
   * Aircraft position. Null when not reported. lat/lon of exactly 0,0 MUST be normalised to null (it means no GPS fix, not the Gulf of Guinea).
   */
  position?: {
    lat: number
    lon: number
    alt_geodetic_m?: number | null
    alt_pressure_m?: number | null
    height_agl_m?: number | null
    h_accuracy_m?: number | null
    v_accuracy_m?: number | null
  } | null
  kinematics?: {
    speed_mps?: number | null
    track_deg?: number | null
    vertical_speed_mps?: number | null
  } | null
  /**
   * SENSITIVE. Operator ground position from F3411 System or DJI 0x10. Subject to separate short retention; omitted by the API unless explicitly enabled.
   */
  operator?: {
    lat: number
    lon: number
    alt_m?: number | null
  } | null
  /**
   * Class E/F only. Envelope characterisation for control links and analog video. Deliberately does NOT include demodulated payload - see legal-and-ethics.md.
   */
  signal_features?: {
    burst_rate_hz?: number | null
    burst_duration_us?: number | null
    duty_cycle?: number | null
    hop_count?: number | null
    occupied_bw_hz?: number | null
    protocol_hint?: string | null
  } | null
  /**
   * Class D only.
   */
  adsb?: {
    icao: string
    callsign?: string | null
    alt_ft?: number | null
    ground_speed_kt?: number | null
  } | null
  /**
   * Source bytes, retained so parser fixes can be applied retroactively.
   */
  raw?: {
    encoding: 'base64'
    bytes: string
    parser: string
  } | null
}

/**
 * Periodic sensor liveness report, emitted unconditionally so 'no drones present' and 'sensor wedged' stay distinguishable (ADR-0003). Every emitter -- sensor-wifi, sensor-sdr, and fusion's network ADS-B feed -- sends this exact shape on the heartbeat.<kind> topic.
 */
export interface Heartbeat {
  schema_version: '1.0'
  /**
   * RFC3339 UTC. Historically sensor-wifi sent an epoch float here and the API's FlexTime papered over the divergence; RFC3339 is now the contract, matching the detection schema.
   */
  ts: string
  sensor_id: string
  sensor_kind: 'wifi' | 'sdr' | 'ble' | 'net'
  /**
   * The state of the sensor's own machinery, never of the sky. An empty sky is healthy; an unreachable radio or decoder is not.
   */
  healthy: boolean
  /**
   * Messages put on the bus since the process started.
   */
  published: number
  /**
   * Messages refused by the bus (backpressure) since the process started.
   */
  dropped: number
  /**
   * Sensor-specific diagnostics. Deliberately free-form: each sensor kind reports different machinery, and consumers must tolerate unknown keys here.
   */
  detail: {}
}

/**
 * Fusion's stateful correlation of Detections over time. The unit both the CLI and the web app render.
 */
export interface Track {
  schema_version: '1.0'
  track_id: string
  /**
   * TENTATIVE=seen once, CONFIRMED=corroborated, COASTING=lost but recent, CLOSED=expired
   */
  state: 'TENTATIVE' | 'CONFIRMED' | 'COASTING' | 'CLOSED'
  first_seen: string
  last_seen: string
  detection_count: number
  identity?: {
    serial?: string | null
    macs?: string[]
    vendor?: string | null
    /**
     * ANSI/CTA-2063-A code from the serial. Survives MAC randomisation, unlike an OUI.
     */
    manufacturer_code?: string | null
    model_hint?: string | null
    operator_id?: string | null
    ua_type?: string | null
  }
  /**
   * Noisy-OR over distinct evidence classes. Answers 'is this really a drone', NOT 'is this a threat'.
   */
  confidence: number
  evidence?: {
    class: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'
    sensor_kind: 'wifi' | 'sdr' | 'ble' | 'net'
    weight: number
    count: number
    last_seen?: string
  }[]
  current?: Position
  history?: Position[]
  /**
   * SENSITIVE. Omitted by the API unless CLASSG_EXPOSE_OPERATOR_LOCATION=true. Clients MUST tolerate absence.
   */
  operator?: Position | null
  /**
   * Strongest signal ANY receiver on this track reported. On a unit with two Wi-Fi radios of different gain this is a mixed measure -- use `receivers` to attribute it before treating it as a range proxy.
   */
  rssi_dbm?: number | null
  /**
   * Per-receiver contribution, sorted by sensor_id. A unit can carry several radios covering different parts of the spectrum, and the same aircraft heard by more than one of them is corroboration a single receiver cannot provide. Also the only place a per-radio RSSI survives: `rssi_dbm` above flattens them together.
   */
  receivers?: {
    sensor_id: string
    sensor_kind: 'wifi' | 'sdr' | 'ble' | 'net'
    /**
     * Detections this receiver contributed. These sum to detection_count, which therefore counts one beacon twice when two receivers both hear it -- unavoidable on overlapping channel plans, and visible here rather than only in the total.
     */
    detection_count: number
    rssi_dbm?: number | null
    last_seen?: string
  }[]
  adsb_correlated?: boolean
}
export interface Position {
  lat: number
  lon: number
  alt_geodetic_m?: number | null
  height_agl_m?: number | null
  /**
   * Ground elevation under this fix, from a terrain model rather than from any sensor. Present ONLY when fusion derived height_agl_m by subtracting it -- its absence alongside a height_agl_m means the aircraft reported that height itself. Consumers that care about provenance must check this rather than trusting height_agl_m to have come from the aircraft.
   */
  terrain_elevation_m?: number | null
  speed_mps?: number | null
  track_deg?: number | null
  at?: string
}

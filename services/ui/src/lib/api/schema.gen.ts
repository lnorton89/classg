/* eslint-disable */
/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Derived from the normative JSON Schemas in `schemas/`.
 * Regenerate with: npm run gen:types
 */

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
    sensor_kind: 'wifi' | 'sdr' | 'ble'
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
  rssi_dbm?: number | null
  adsb_correlated?: boolean
}
export interface Position {
  lat: number
  lon: number
  alt_geodetic_m?: number | null
  height_agl_m?: number | null
  speed_mps?: number | null
  track_deg?: number | null
  at?: string
}

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
  sensor_kind: 'wifi' | 'sdr' | 'ble'
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

// Package model holds the wire types from schemas/*.schema.json.
//
// These are deliberately declared here rather than imported from
// services/fusion. fusion's Go structs are its internal representation and are
// already a slightly different shape from the published schema (evidence is a
// map there, an array in the schema; there is no schema_version). Importing
// them would make every future fusion refactor a wire-format change. The
// schema is the contract; this package implements the schema.
package model

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const SchemaVersion = "1.0"

// Position serves two schemas: track positions (track.schema.json, where `at`
// is fusion's fix timestamp) and detection positions (detection.schema.json,
// which has no `at` and whose additionalProperties:false forbids one).
//
// Ingest stores json.Marshal of this struct as the PERMANENT record, so every
// field the schemas define must exist here -- a field this struct lacks is
// stripped from history forever, which defeats the whole reason raw detections
// are retained (replaying parser fixes; see Raw). alt_pressure_m and the two
// accuracy fields were lost exactly that way until they were added.
type Position struct {
	Lat               float64  `json:"lat"`
	Lon               float64  `json:"lon"`
	AltGeodeticM      *float64 `json:"alt_geodetic_m,omitempty"`
	AltPressureM      *float64 `json:"alt_pressure_m,omitempty"`
	HeightAGLM        *float64 `json:"height_agl_m,omitempty"`
	TerrainElevationM *float64 `json:"terrain_elevation_m,omitempty"`
	SpeedMPS          *float64 `json:"speed_mps,omitempty"`
	TrackDeg          *float64 `json:"track_deg,omitempty"`
	HAccuracyM        *float64 `json:"h_accuracy_m,omitempty"`
	VAccuracyM        *float64 `json:"v_accuracy_m,omitempty"`
	// omitzero, because detection positions have no timestamp of their own:
	// without it every stored and served detection grew an
	// "at":"0001-01-01T00:00:00Z" that detection.schema.json rejects. Track
	// positions always carry a real fix time from fusion.
	At time.Time `json:"at,omitzero"`
}

// OperatorPosition is the operator's ground position, from an F3411 System
// message or DJI subcommand 0x10. It is a distinct type from Position so that
// "did I just serialise the pilot's location rather than the aircraft's" is a
// question the type system can answer.
type OperatorPosition struct {
	Lat  float64  `json:"lat"`
	Lon  float64  `json:"lon"`
	AltM *float64 `json:"alt_m,omitempty"`
	// omitzero, not omitempty: omitempty never omits a struct, so the zero
	// value used to serialise as "at":"0001-01-01T00:00:00Z" -- a field
	// detection.schema.json's operator object forbids outright.
	At time.Time `json:"at,omitzero"`
}

type Evidence struct {
	Class      string    `json:"class"`
	SensorKind string    `json:"sensor_kind"`
	Weight     float64   `json:"weight"`
	Count      int       `json:"count"`
	LastSeen   time.Time `json:"last_seen,omitempty"`
}

type TrackIdentity struct {
	Serial           string   `json:"serial,omitempty"`
	MACs             []string `json:"macs,omitempty"`
	Vendor           string   `json:"vendor,omitempty"`
	ManufacturerCode string   `json:"manufacturer_code,omitempty"`
	ModelHint        string   `json:"model_hint,omitempty"`
	OperatorID       string   `json:"operator_id,omitempty"`
	UAType           string   `json:"ua_type,omitempty"`
}

type Track struct {
	SchemaVersion  string        `json:"schema_version"`
	TrackID        string        `json:"track_id"`
	State          string        `json:"state"`
	FirstSeen      time.Time     `json:"first_seen"`
	LastSeen       time.Time     `json:"last_seen"`
	DetectionCount int           `json:"detection_count"`
	Identity       TrackIdentity `json:"identity"`
	Confidence     float64       `json:"confidence"`
	Evidence       []Evidence    `json:"evidence,omitempty"`
	Current        *Position     `json:"current,omitempty"`
	History        []Position    `json:"history,omitempty"`

	// Operator is the pilot's ground position. Included by default; set
	// CLASSG_EXPOSE_OPERATOR_LOCATION=false to strip it from every response.
	// Clients must tolerate its absence either way (track.schema.json).
	Operator *OperatorPosition `json:"operator,omitempty"`

	RSSIdBm *float64 `json:"rssi_dbm,omitempty"`
	// Receivers attributes RSSIdBm to the radio that measured it, and records
	// which radios heard this track at all. Carried through rather than
	// recomputed: this struct is what a stored track decodes into, so a field
	// missing here is a field silently dropped between fusion and every client.
	Receivers      []Receiver `json:"receivers,omitempty"`
	ADSBCorrelated bool       `json:"adsb_correlated"`
}

// Receiver mirrors the per-receiver entry in track.schema.json.
type Receiver struct {
	SensorID       string     `json:"sensor_id"`
	SensorKind     string     `json:"sensor_kind"`
	DetectionCount int        `json:"detection_count"`
	RSSIdBm        *float64   `json:"rssi_dbm,omitempty"`
	LastSeen       *time.Time `json:"last_seen,omitempty"`
}

// TrackStates is the closed set from track.schema.json, used to reject
// nonsense in the ?state= filter rather than silently returning nothing.
var TrackStates = map[string]bool{
	"TENTATIVE": true, "CONFIRMED": true, "COASTING": true, "CLOSED": true,
}

// DetectionClasses is the closed set from detection.schema.json.
var DetectionClasses = map[string]bool{
	"A": true, "B": true, "C": true, "D": true,
	"E": true, "F": true, "G": true, "H": true,
}

// SensorKinds is the closed set from the schema enum. "net" is a network feed
// relayed to us (the ADS-B uplink heartbeats as one), not a radio on this box.
var SensorKinds = map[string]bool{"wifi": true, "sdr": true, "ble": true, "net": true}

type RF struct {
	FreqHz      *int64   `json:"freq_hz,omitempty"`
	Channel     *int     `json:"channel,omitempty"`
	RSSIdBm     *float64 `json:"rssi_dbm,omitempty"`
	BandwidthHz *int64   `json:"bandwidth_hz,omitempty"`
	SNRdB       *float64 `json:"snr_db,omitempty"`
}

type DetectionIdentity struct {
	Serial     string `json:"serial,omitempty"`
	MAC        string `json:"mac,omitempty"`
	IDType     string `json:"id_type,omitempty"`
	UAType     string `json:"ua_type,omitempty"`
	OperatorID string `json:"operator_id,omitempty"`
	SelfID     string `json:"self_id,omitempty"`
	VendorHint string `json:"vendor_hint,omitempty"`
}

type Kinematics struct {
	SpeedMPS         *float64 `json:"speed_mps,omitempty"`
	TrackDeg         *float64 `json:"track_deg,omitempty"`
	VerticalSpeedMPS *float64 `json:"vertical_speed_mps,omitempty"`
}

type SignalFeatures struct {
	BurstRateHz     *float64 `json:"burst_rate_hz,omitempty"`
	BurstDurationUS *float64 `json:"burst_duration_us,omitempty"`
	DutyCycle       *float64 `json:"duty_cycle,omitempty"`
	HopCount        *int     `json:"hop_count,omitempty"`
	OccupiedBWHz    *int64   `json:"occupied_bw_hz,omitempty"`
	ProtocolHint    string   `json:"protocol_hint,omitempty"`
}

type ADSB struct {
	ICAO          string   `json:"icao"`
	Callsign      string   `json:"callsign,omitempty"`
	AltFt         *int     `json:"alt_ft,omitempty"`
	GroundSpeedKt *float64 `json:"ground_speed_kt,omitempty"`
}

// Raw is the source vendor IE, not a PCAP. data-model.md keeps it so parser
// fixes can be replayed over history. It is a few hundred bytes of a beacon
// the drone broadcast publicly -- it is not, and must never become, a path to
// the full capture, which contains every network in range.
type Raw struct {
	Encoding string `json:"encoding"`
	Bytes    string `json:"bytes"`
	Parser   string `json:"parser"`
}

type Detection struct {
	SchemaVersion string `json:"schema_version"`
	DetectionID   string `json:"detection_id"`
	// TS decodes both RFC3339 and float epoch seconds. See FlexTime.
	TS             FlexTime          `json:"ts"`
	SensorID       string            `json:"sensor_id"`
	SensorKind     string            `json:"sensor_kind"`
	DetectionClass string            `json:"detection_class"`
	RF             *RF               `json:"rf,omitempty"`
	Identity       DetectionIdentity `json:"identity,omitempty"`
	Position       *Position         `json:"position,omitempty"`
	Kinematics     *Kinematics       `json:"kinematics,omitempty"`
	Operator       *OperatorPosition `json:"operator,omitempty"`
	SignalFeatures *SignalFeatures   `json:"signal_features,omitempty"`
	ADSB           *ADSB             `json:"adsb,omitempty"`
	Raw            *Raw              `json:"raw,omitempty"`
}

// Redact returns t with the operator ground position removed unless expose is
// set. Value receiver: the caller cannot accidentally hold a reference to the
// un-redacted original.
func (t Track) Redact(expose bool) Track {
	if !expose {
		t.Operator = nil
	}
	return t
}

func (d Detection) Redact(expose bool) Detection {
	if !expose {
		d.Operator = nil
	}
	return d
}

func RedactTracks(ts []Track, expose bool) []Track {
	out := make([]Track, len(ts))
	for i, t := range ts {
		out[i] = t.Redact(expose)
	}
	return out
}

func RedactDetections(ds []Detection, expose bool) []Detection {
	out := make([]Detection, len(ds))
	for i, d := range ds {
		out[i] = d.Redact(expose)
	}
	return out
}

// FlexTime accepts RFC3339 or a numeric epoch, and always emits RFC3339.
//
// Historically the Wi-Fi sensor published heartbeats with `"ts": time.time()`
// -- a float. As of schemas/heartbeat.schema.json both sensors emit RFC3339,
// so nothing CURRENT needs the epoch path. It stays because the API cannot
// verify what build a field-deployed sensor is running: an upgraded API next
// to a not-yet-upgraded sensor would otherwise drop every heartbeat as
// malformed, and a sensor that vanished because of a decode rule is exactly
// the silent failure /health exists to prevent. Collapse this to time.Time
// only once no supported deployment can still emit floats.
type FlexTime struct{ time.Time }

func (f *FlexTime) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		if s == "" {
			return nil
		}
		t, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return fmt.Errorf("ts %q: %w", s, err)
		}
		f.Time = t.UTC()
		return nil
	}
	// Parse the decimal text directly. Converting the entire value to float64
	// first loses sub-second precision because Unix seconds already consume most
	// of the mantissa (for example .482 became .482000112).
	parts := strings.SplitN(string(bytes.TrimSpace(b)), ".", 2)
	sec, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return fmt.Errorf("ts: not RFC3339 or epoch seconds: %w", err)
	}
	var nsec int64
	if len(parts) == 2 {
		fraction := parts[1]
		if fraction == "" || len(fraction) > 9 {
			return fmt.Errorf("ts: invalid fractional epoch seconds %q", string(b))
		}
		fraction += strings.Repeat("0", 9-len(fraction))
		nsec, err = strconv.ParseInt(fraction, 10, 64)
		if err != nil {
			return fmt.Errorf("ts: invalid fractional epoch seconds: %w", err)
		}
	}
	f.Time = time.Unix(sec, nsec).UTC()
	return nil
}

func (f FlexTime) MarshalJSON() ([]byte, error) {
	return json.Marshal(f.Time.UTC().Format(time.RFC3339Nano))
}

// DecodeTrack parses a track from the bus.
//
// Tolerant about `evidence` because the shape fusion publishes is not yet
// pinned down: track.schema.json says array, but fusion's in-memory Track
// holds a map keyed by class and would marshal as an object. Accepting both
// costs twenty lines and avoids a silent field loss if fusion ships the naive
// marshalling. Flagged in docs/architecture/api-implementation.md.
func DecodeTrack(b []byte) (Track, error) {
	var raw struct {
		Track
		Evidence json.RawMessage `json:"evidence"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return Track{}, fmt.Errorf("decode track: %w", err)
	}
	t := raw.Track
	t.Evidence = nil

	if len(raw.Evidence) > 0 && string(raw.Evidence) != "null" {
		var asArray []Evidence
		if err := json.Unmarshal(raw.Evidence, &asArray); err == nil {
			t.Evidence = asArray
		} else {
			var asMap map[string]Evidence
			if err := json.Unmarshal(raw.Evidence, &asMap); err != nil {
				return Track{}, fmt.Errorf("decode track evidence: %w", err)
			}
			for class, e := range asMap {
				if e.Class == "" {
					e.Class = class
				}
				t.Evidence = append(t.Evidence, e)
			}
			sortEvidence(t.Evidence)
		}
	}

	if t.SchemaVersion == "" {
		t.SchemaVersion = SchemaVersion
	}
	if t.TrackID == "" {
		return Track{}, fmt.Errorf("decode track: missing track_id")
	}
	if !TrackStates[t.State] {
		return Track{}, fmt.Errorf("decode track: unknown state %q", t.State)
	}
	return t, nil
}

// sortEvidence keeps map-sourced evidence in a stable order so responses do not
// change shape between requests for the same track.
func sortEvidence(e []Evidence) {
	for i := 1; i < len(e); i++ {
		for j := i; j > 0 && e[j].Class < e[j-1].Class; j-- {
			e[j], e[j-1] = e[j-1], e[j]
		}
	}
}

func DecodeDetection(b []byte) (Detection, error) {
	var d Detection
	if err := json.Unmarshal(b, &d); err != nil {
		return Detection{}, fmt.Errorf("decode detection: %w", err)
	}
	if d.SchemaVersion == "" {
		d.SchemaVersion = SchemaVersion
	}
	if d.SensorID == "" || !DetectionClasses[d.DetectionClass] {
		return Detection{}, fmt.Errorf("decode detection: missing sensor_id or bad detection_class %q", d.DetectionClass)
	}
	// Sensors are supposed to normalise 0,0 to null. fusion re-checks this and
	// so do we: the API is the last place to stop a bad sensor build putting
	// every track in the Gulf of Guinea.
	if d.Position != nil && d.Position.Lat == 0 && d.Position.Lon == 0 {
		d.Position = nil
	}
	if d.Operator != nil && d.Operator.Lat == 0 && d.Operator.Lon == 0 {
		d.Operator = nil
	}
	return d, nil
}

// Capture mirrors the object in api-contract.md#captures.
type Capture struct {
	CaptureID  string           `json:"capture_id"`
	Filename   string           `json:"filename"`
	State      string           `json:"state"`
	StartedAt  time.Time        `json:"started_at"`
	EndedAt    *time.Time       `json:"ended_at,omitempty"`
	Iface      string           `json:"iface"`
	Channel    int              `json:"channel"`
	DurationS  int              `json:"duration_s"`
	SizeBytes  int64            `json:"size_bytes"`
	FrameCount int              `json:"frame_count"`
	Label      string           `json:"label,omitempty"`
	Error      string           `json:"error,omitempty"`
	Analysis   *CaptureAnalysis `json:"analysis,omitempty"`
}

const (
	CaptureRunning   = "running"
	CaptureCompleted = "completed"
	CaptureFailed    = "failed"
)

type CaptureAnalysis struct {
	Analyzed          bool `json:"analyzed"`
	DroneTransmitters int  `json:"drone_transmitters"`
	ClassA            int  `json:"class_a"`
	ClassB            int  `json:"class_b"`
}

// SpectrumSweep is one band, measured once, by the SDR sensor's sweep engine.
//
// This is the metadata half. The bins themselves are a megabyte for the widest
// band and live behind GET /spectrum/sweeps/{id}, so a list of sweeps stays a
// list rather than a bulk download.
//
// Everything here is an ENERGY measurement and nothing here classifies. A peak
// above threshold means "something is transmitting", never "a drone" -- the
// detector that could tell those apart is Milestone 3 and needs a test
// transmitter to validate. See services/sensor-sdr/src/sweep.rs.
type SpectrumSweep struct {
	SweepID   string     `json:"sweep_id"`
	Band      string     `json:"band"`
	State     string     `json:"state"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`

	// Class the band would produce if a detector existed, from BAND_PLANS.
	Class   string `json:"class,omitempty"`
	Note    string `json:"note,omitempty"`
	StartHz int64  `json:"start_hz,omitempty"`
	StopHz  int64  `json:"stop_hz,omitempty"`
	Steps   int    `json:"steps,omitempty"`

	// Nil until the sweep finishes, and nil forever if it failed. A missing
	// floor is not a floor of 0 dBFS -- that would read as a full-scale signal
	// across the whole band, which is the most alarming possible way to render
	// "we did not measure".
	NoiseFloorDBFS *float64 `json:"noise_floor_dbfs,omitempty"`
	ThresholdDBFS  *float64 `json:"threshold_dbfs,omitempty"`
	PeakDBFS       *float64 `json:"peak_dbfs,omitempty"`
	PeakHz         *float64 `json:"peak_hz,omitempty"`

	// Steps that read short. Non-empty means the band was not fully covered and
	// the trace has genuine holes in it.
	ShortReads int `json:"short_reads,omitempty"`

	Error string `json:"error,omitempty"`
}

const (
	SweepRunning   = "running"
	SweepCompleted = "completed"
	SweepFailed    = "failed"
)

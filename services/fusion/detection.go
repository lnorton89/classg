package fusion

import (
	"encoding/json"
	"fmt"
	"time"
)

// Detection mirrors schemas/detection.schema.json.
//
// Every field beyond the required core is a pointer or omitempty: a Location
// message with no preceding Basic ID has a position but no serial, and modelling
// that as optional at the type level stops sensors inventing placeholder identity.
type Detection struct {
	SchemaVersion  string    `json:"schema_version"`
	DetectionID    string    `json:"detection_id"`
	TS             time.Time `json:"ts"`
	SensorID       string    `json:"sensor_id"`
	SensorKind     string    `json:"sensor_kind"`
	DetectionClass string    `json:"detection_class"`

	RF struct {
		FreqHz      *int64   `json:"freq_hz"`
		Channel     *int     `json:"channel"`
		RSSIdBm     *float64 `json:"rssi_dbm"`
		BandwidthHz *int64   `json:"bandwidth_hz"`
	} `json:"rf"`

	Identity struct {
		Serial     string `json:"serial"`
		MAC        string `json:"mac"`
		IDType     string `json:"id_type"`
		UAType     string `json:"ua_type"`
		OperatorID string `json:"operator_id"`
		SelfID     string `json:"self_id"`
		VendorHint string `json:"vendor_hint"`
	} `json:"identity"`

	Position *struct {
		Lat          float64  `json:"lat"`
		Lon          float64  `json:"lon"`
		AltGeodeticM *float64 `json:"alt_geodetic_m"`
		HeightAGLM   *float64 `json:"height_agl_m"`
	} `json:"position"`

	Kinematics *struct {
		SpeedMPS         *float64 `json:"speed_mps"`
		TrackDeg         *float64 `json:"track_deg"`
		VerticalSpeedMPS *float64 `json:"vertical_speed_mps"`
	} `json:"kinematics"`

	Operator *struct {
		Lat  float64  `json:"lat"`
		Lon  float64  `json:"lon"`
		AltM *float64 `json:"alt_m"`
	} `json:"operator"`

	ADSB *struct {
		ICAO     string `json:"icao"`
		Callsign string `json:"callsign"`
		AltFt    *int   `json:"alt_ft"`
	} `json:"adsb"`
}

func ParseDetection(payload []byte) (Detection, error) {
	var d Detection
	if err := json.Unmarshal(payload, &d); err != nil {
		return d, fmt.Errorf("decode detection: %w", err)
	}
	if d.SchemaVersion == "" || d.DetectionClass == "" || d.SensorID == "" {
		return d, fmt.Errorf("detection missing required fields")
	}
	// Sensors are supposed to normalise 0,0 to null. Defensive check: a bad
	// sensor build must not be able to drag every track to the Gulf of Guinea.
	if d.Position != nil && d.Position.Lat == 0 && d.Position.Lon == 0 {
		d.Position = nil
	}
	return d, nil
}

// DefaultWeights - see docs/architecture/data-model.md#confidence-scoring.
// These are calibrated hypotheses, not constants. Revise against measured
// false-positive rates from test T7 once a corpus exists.
func DefaultWeights() map[string]float64 {
	return map[string]float64{
		"A": 0.60, // ASTM F3411 Remote ID -- standards-compliant, self-identifying
		"B": 0.50, // DJI DroneID -- vendor-specific but unambiguous
		"C": 0.10, // Wi-Fi OUI/SSID -- weakest; MAC randomisation, OUI reuse
		"D": 0.00, // ADS-B -- never contributes; used only for suppression
		"E": 0.30, // control-link cadence -- strong but inferential, ISM clutter
		"F": 0.25, // analog FPV video -- distinctive but shared bands
		"G": 0.60, // BLE Remote ID -- same payload semantics as A
		"H": 0.00, // GNSS interference -- an indicator, not a drone detection
	}
}

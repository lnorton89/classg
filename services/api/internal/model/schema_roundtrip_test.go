package model

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// compileDetectionSchema loads the real contract, not a copy of it. The whole
// point of this test is that the struct in this package and the schema four
// services share cannot drift apart silently again.
func compileDetectionSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	source, err := os.ReadFile("../../../../schemas/detection.schema.json")
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(source))
	if err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("detection.schema.json", doc); err != nil {
		t.Fatalf("add schema: %v", err)
	}
	schema, err := compiler.Compile("detection.schema.json")
	if err != nil {
		t.Fatalf("compile schema: %v", err)
	}
	return schema
}

// Ingest stores json.Marshal(d) as the permanent record of a detection and
// the API serves that same shape back out, so what this round trip preserves
// IS the contract. Two prior regressions, both invisible to every other test:
//
//   - Position lacked alt_pressure_m, h_accuracy_m and v_accuracy_m, so three
//     fields the sensor reported were stripped from stored history forever --
//     unrecoverable evidence loss, since raw detections are retained precisely
//     so parser fixes can be replayed over them.
//   - Position.At and OperatorPosition.At serialised their zero value as
//     "at":"0001-01-01T00:00:00Z", which detection.schema.json forbids
//     (additionalProperties: false on both objects).
func TestDetectionRoundTripsThroughTheSchema(t *testing.T) {
	// A detection as the Wi-Fi sensor emits it, exercising every position
	// field the schema defines. No "at" anywhere: detections do not have one.
	src := `{
	  "schema_version": "1.0",
	  "detection_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	  "ts": "2026-08-18T12:00:00.482Z",
	  "sensor_id": "wifi-0",
	  "sensor_kind": "wifi",
	  "detection_class": "A",
	  "rf": {"freq_hz": 2437000000, "channel": 6, "rssi_dbm": -61},
	  "identity": {
	    "serial": "1581F9DEC259E0296040",
	    "mac": "8c:1e:d9:fc:bb:cc",
	    "id_type": "serial_ansi_cta_2063",
	    "ua_type": "multirotor"
	  },
	  "position": {
	    "lat": 51.5007,
	    "lon": -0.1246,
	    "alt_geodetic_m": 120.5,
	    "alt_pressure_m": 118.2,
	    "height_agl_m": 95.0,
	    "h_accuracy_m": 3.0,
	    "v_accuracy_m": 4.5
	  },
	  "kinematics": {"speed_mps": 12.4, "track_deg": 187.5},
	  "operator": {"lat": 51.5001, "lon": -0.1240, "alt_m": 22.0},
	  "raw": {"encoding": "base64", "bytes": "DUYAAAE=", "parser": "odid/1.2"}
	}`

	d, err := DecodeDetection([]byte(src))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	out, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// Half one: nothing the sensor said was destroyed.
	var emitted map[string]any
	if err := json.Unmarshal(out, &emitted); err != nil {
		t.Fatal(err)
	}
	position, _ := emitted["position"].(map[string]any)
	if position == nil {
		t.Fatalf("position vanished: %s", out)
	}
	for field, want := range map[string]float64{
		"alt_geodetic_m": 120.5,
		"alt_pressure_m": 118.2,
		"height_agl_m":   95.0,
		"h_accuracy_m":   3.0,
		"v_accuracy_m":   4.5,
	} {
		got, ok := position[field].(float64)
		if !ok || got != want {
			t.Errorf("position.%s = %v, want %v -- a field the schema defines was destroyed on the round trip", field, position[field], want)
		}
	}

	// Half two: the emitted document still satisfies the contract. This is
	// what catches an invented field -- the zero-valued "at" both position
	// types used to grow -- because both objects set additionalProperties
	// to false.
	schema := compileDetectionSchema(t)
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(instance); err != nil {
		t.Errorf("the API-emitted detection does not satisfy detection.schema.json:\n%s\n%v", out, err)
	}
}

// Detections already stored with the spurious "at" must round-trip back OUT
// clean: the zero timestamp decodes to time.Time's zero value, which omitzero
// then keeps off the wire.
func TestStoredDetectionWithSpuriousAtHealsOnTheWayOut(t *testing.T) {
	src := `{
	  "schema_version": "1.0",
	  "detection_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	  "ts": "2026-08-18T12:00:00Z",
	  "sensor_id": "wifi-0",
	  "sensor_kind": "wifi",
	  "detection_class": "A",
	  "position": {"lat": 51.5, "lon": -0.1, "at": "0001-01-01T00:00:00Z"},
	  "operator": {"lat": 51.5, "lon": -0.12, "at": "0001-01-01T00:00:00Z"}
	}`
	d, err := DecodeDetection([]byte(src))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	out, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if bytes.Contains(out, []byte(`"at"`)) {
		t.Fatalf("the spurious zero-value at survived: %s", out)
	}

	schema := compileDetectionSchema(t)
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(instance); err != nil {
		t.Errorf("re-served stored detection does not satisfy the schema:\n%s\n%v", out, err)
	}
}

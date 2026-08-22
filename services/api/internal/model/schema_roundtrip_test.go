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
	return compileSchema(t, "detection.schema.json")
}

// compileTrackSchema loads track.schema.json, which nothing executable checked
// against until now -- the package referred to it in four comments and verified
// it nowhere.
func compileTrackSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	return compileSchema(t, "track.schema.json")
}

func compileSchema(t *testing.T, name string) *jsonschema.Schema {
	t.Helper()
	source, err := os.ReadFile("../../../../schemas/" + name)
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(source))
	if err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(name, doc); err != nil {
		t.Fatalf("add schema: %v", err)
	}
	schema, err := compiler.Compile(name)
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

// A Track is what the map renders and what an alert rule fires on, and until
// this test nothing in any of the four languages validated one against
// track.schema.json -- the contract was referenced in comments and checked
// nowhere.
//
// The shape that matters most here is `evidence`. The schema says an ARRAY;
// fusion holds it as a map keyed by class and used to publish it that way, so
// the API normalises. A regression there is invisible to every other test
// because model.DecodeTrack deliberately accepts both.
func TestTrackRoundTripsThroughTheSchema(t *testing.T) {
	src := `{
	  "schema_version": "1.0",
	  "track_id": "01J8XQ0000000000000000000T",
	  "state": "CONFIRMED",
	  "first_seen": "2026-08-11T14:23:11.482Z",
	  "last_seen": "2026-08-11T14:24:02.100Z",
	  "detection_count": 42,
	  "confidence": 0.82,
	  "adsb_correlated": false,
	  "identity": {"serial": "1596F3B24C5D7E8F9A0B"},
	  "evidence": {
	    "A": {"class": "A", "sensor_kind": "wifi", "weight": 0.6, "count": 30,
	          "last_seen": "2026-08-11T14:24:02.100Z"},
	    "B": {"class": "B", "sensor_kind": "wifi", "weight": 0.3, "count": 12,
	          "last_seen": "2026-08-11T14:23:59.000Z"}
	  },
	  "receivers": [
	    {"sensor_id": "wifi-0", "sensor_kind": "wifi", "detection_count": 30,
	     "rssi_dbm": -46.0, "last_seen": "2026-08-11T14:24:02.100Z"},
	    {"sensor_id": "wifi-1", "sensor_kind": "wifi", "detection_count": 12,
	     "rssi_dbm": -71.0, "last_seen": "2026-08-11T14:23:59.000Z"}
	  ],
	  "current": {"lat": 47.3769, "lon": 8.5417, "alt_geodetic_m": 510.0,
	              "at": "2026-08-11T14:24:02.100Z"}
	}`

	// DecodeTrack, not json.Unmarshal: the map-to-array normalisation lives
	// there, and it is the path the bus subscriber actually uses. Decoding any
	// other way tests a shape nothing receives.
	tr, err := DecodeTrack([]byte(src))
	if err != nil {
		t.Fatalf("decoding a fusion track: %v", err)
	}

	out, merr := json.Marshal(tr)
	if merr != nil {
		t.Fatalf("re-marshalling: %v", merr)
	}

	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("parsing what we emit: %v", err)
	}
	if err := compileTrackSchema(t).Validate(doc); err != nil {
		t.Fatalf("the API emits a track track.schema.json rejects: %v (emitted: %s)", err, out)
	}

	// The normalisation is the point: fusion's map must leave as the schema's
	// array, not as an object the schema happens not to look inside.
	var round map[string]any
	if err := json.Unmarshal(out, &round); err != nil {
		t.Fatal(err)
	}
	ev, ok := round["evidence"].([]any)
	if !ok {
		t.Fatalf("evidence came out as %T, want an array", round["evidence"])
	}
	if len(ev) != 2 {
		t.Fatalf("evidence has %d entries, want 2", len(ev))
	}

	// Track is a struct, so a field it does not declare is dropped in silence
	// on the way through -- the API would keep serving schema-valid tracks with
	// the per-receiver attribution quietly missing, which is indistinguishable
	// downstream from a unit that only ever had one radio.
	rx, ok := round["receivers"].([]any)
	if !ok {
		t.Fatalf("receivers came out as %T, want an array", round["receivers"])
	}
	if len(rx) != 2 {
		t.Fatalf("receivers has %d entries, want both radios", len(rx))
	}
	first, _ := rx[0].(map[string]any)
	if first["sensor_id"] != "wifi-0" || first["rssi_dbm"] != -46.0 {
		t.Fatalf("first receiver = %+v, want wifi-0 at -46 dBm", first)
	}
}

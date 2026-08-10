package model

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestDecodeTrackEvidenceShapes covers the one place the bus format is not
// pinned down: track.schema.json says evidence is an array, but fusion's
// in-memory Track holds a map keyed by class and would marshal as an object.
func TestDecodeTrackEvidenceShapes(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		wantCount int
		wantFirst string
	}{
		{
			name:      "array, as the schema specifies",
			body:      `{"track_id":"T1","state":"CONFIRMED","evidence":[{"class":"A","sensor_kind":"wifi","weight":0.6,"count":4}]}`,
			wantCount: 1, wantFirst: "A",
		},
		{
			name:      "object keyed by class, as fusion would marshal it",
			body:      `{"track_id":"T1","state":"CONFIRMED","evidence":{"B":{"sensor_kind":"wifi","weight":0.5,"count":2},"A":{"sensor_kind":"wifi","weight":0.6,"count":4}}}`,
			wantCount: 2, wantFirst: "A",
		},
		{
			name:      "absent",
			body:      `{"track_id":"T1","state":"CONFIRMED"}`,
			wantCount: 0,
		},
		{
			name:      "null",
			body:      `{"track_id":"T1","state":"CONFIRMED","evidence":null}`,
			wantCount: 0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tr, err := DecodeTrack([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if len(tr.Evidence) != tc.wantCount {
				t.Fatalf("evidence count: got %d want %d (%+v)", len(tr.Evidence), tc.wantCount, tr.Evidence)
			}
			if tc.wantFirst != "" && tr.Evidence[0].Class != tc.wantFirst {
				t.Fatalf("first evidence class: got %q want %q", tr.Evidence[0].Class, tc.wantFirst)
			}
			if tr.SchemaVersion != SchemaVersion {
				t.Fatalf("schema_version should be filled in: %q", tr.SchemaVersion)
			}
		})
	}
}

func TestDecodeTrackRejectsNonsense(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"not json", `nope`},
		{"no track_id", `{"state":"CONFIRMED"}`},
		{"unknown state", `{"track_id":"T1","state":"FLYING"}`},
		{"empty state", `{"track_id":"T1"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := DecodeTrack([]byte(tc.body)); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

// TestFlexTime covers the sensor's float epoch alongside the schema's RFC3339.
func TestFlexTime(t *testing.T) {
	want := time.Date(2026, 8, 10, 14, 23, 11, 482000000, time.UTC)
	tests := []struct {
		name string
		body string
		want time.Time
	}{
		{"rfc3339 with milliseconds", `"2026-08-10T14:23:11.482Z"`, want},
		{"rfc3339 with an offset", `"2026-08-10T16:23:11.482+02:00"`, want},
		{"float epoch, as classg_wifi/bus.py emits", `1786026191.482`, time.Unix(1786026191, 482000000).UTC()},
		{"integer epoch", `1786026191`, time.Unix(1786026191, 0).UTC()},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var f FlexTime
			if err := json.Unmarshal([]byte(tc.body), &f); err != nil {
				t.Fatal(err)
			}
			if !f.Time.Equal(tc.want) {
				t.Fatalf("got %v want %v", f.Time, tc.want)
			}
			// Whatever came in, RFC3339 goes out.
			out, err := json.Marshal(f)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(string(out), `"20`) || !strings.HasSuffix(string(out), `Z"`) {
				t.Fatalf("must re-emit as RFC3339 UTC, got %s", out)
			}
		})
	}
}

// TestZeroPositionIsNoGPSFix mirrors the check fusion already makes. The API
// is the last place to stop a bad sensor build putting every track in the
// Gulf of Guinea.
func TestZeroPositionIsNoGPSFix(t *testing.T) {
	body := `{"schema_version":"1.0","detection_id":"D1","ts":"2026-08-10T00:00:00Z",
		"sensor_id":"wifi-0","sensor_kind":"wifi","detection_class":"A",
		"position":{"lat":0,"lon":0},"operator":{"lat":0,"lon":0}}`
	d, err := DecodeDetection([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if d.Position != nil {
		t.Error("0,0 aircraft position should be treated as no GPS fix")
	}
	if d.Operator != nil {
		t.Error("0,0 operator position should be treated as no GPS fix")
	}
}

func TestDecodeDetectionRejectsBadClass(t *testing.T) {
	tests := []string{
		`{"detection_id":"D1","sensor_id":"wifi-0","detection_class":"Z"}`,
		`{"detection_id":"D1","sensor_id":"wifi-0"}`,
		`{"detection_id":"D1","detection_class":"A"}`,
	}
	for _, body := range tests {
		if _, err := DecodeDetection([]byte(body)); err == nil {
			t.Fatalf("want an error for %s", body)
		}
	}
}

// TestRedactDoesNotMutateTheOriginal: Redact takes a value receiver so a
// caller cannot end up holding a half-redacted copy that shares memory.
func TestRedactDoesNotMutateTheOriginal(t *testing.T) {
	original := Track{
		TrackID:  "T1",
		Operator: &OperatorPosition{Lat: 47.375, Lon: 8.54},
	}
	redacted := original.Redact(false)
	if redacted.Operator != nil {
		t.Fatal("redacted copy still carries the operator position")
	}
	if original.Operator == nil {
		t.Fatal("Redact mutated its receiver")
	}

	kept := original.Redact(true)
	if kept.Operator == nil || kept.Operator.Lat != 47.375 {
		t.Fatal("expose=true should keep the operator position")
	}
}

func TestRedactSlices(t *testing.T) {
	tracks := []Track{{TrackID: "T1", Operator: &OperatorPosition{Lat: 1, Lon: 2}}}
	if got := RedactTracks(tracks, false); got[0].Operator != nil {
		t.Fatal("track slice not redacted")
	}
	if tracks[0].Operator == nil {
		t.Fatal("RedactTracks mutated its input")
	}

	dets := []Detection{{DetectionID: "D1", Operator: &OperatorPosition{Lat: 1, Lon: 2}}}
	if got := RedactDetections(dets, false); got[0].Operator != nil {
		t.Fatal("detection slice not redacted")
	}
	if dets[0].Operator == nil {
		t.Fatal("RedactDetections mutated its input")
	}
}

// TestNoThreatFieldsOnTheWire: confidence answers "is this really a drone".
// Anything that relabels it as threat, priority or risk is out of contract,
// and the cheapest place to catch a reintroduction is the serialised form.
func TestNoThreatFieldsOnTheWire(t *testing.T) {
	tr := Track{TrackID: "T1", State: "CONFIRMED", Confidence: 0.82}
	body, err := json.Marshal(tr)
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"threat", "priority", "risk", "severity", "hostile"} {
		if strings.Contains(strings.ToLower(string(body)), banned) {
			t.Errorf("track serialisation contains %q: %s", banned, body)
		}
	}

	d := Detection{DetectionID: "D1", SensorID: "wifi-0", DetectionClass: "A"}
	body, _ = json.Marshal(d)
	for _, banned := range []string{"threat", "priority", "risk", "severity", "hostile"} {
		if strings.Contains(strings.ToLower(string(body)), banned) {
			t.Errorf("detection serialisation contains %q: %s", banned, body)
		}
	}
}

package httpapi_test

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
)

func exportTrack(t *testing.T, h *harness, id, format string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	url := "/api/v1/tracks/" + id + "/export"
	if format != "" {
		url += "?format=" + format
	}
	h.server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func flightTrack(id string) model.Track {
	at := time.Date(2026, 8, 10, 20, 7, 0, 0, time.UTC)
	alt := 120.5
	return model.Track{
		SchemaVersion:  "1.0",
		TrackID:        id,
		State:          "CONFIRMED",
		FirstSeen:      at,
		LastSeen:       at.Add(2 * time.Minute),
		DetectionCount: 3,
		Confidence:     0.87,
		Identity:       model.TrackIdentity{Serial: "1581F5FMD24170012345"},
		History: []model.Position{
			{Lat: 46.035, Lon: -122.1, AltGeodeticM: &alt, At: at},
			{Lat: 46.036, Lon: -122.101, At: at.Add(time.Minute)},
		},
		Operator: &model.OperatorPosition{Lat: 46.0301, Lon: -122.0902},
	}
}

func TestExportGeoJSONUsesLonLatOrder(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.store.UpsertTrack(context.Background(), flightTrack("trk-1")); err != nil {
		t.Fatal(err)
	}

	rec := exportTrack(t, h, "trk-1", "geojson")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	var doc struct {
		Type     string `json:"type"`
		Features []struct {
			Geometry struct {
				Type string `json:"type"`
				// Raw, because the path feature's coordinates are [][]float64
				// while the operator point's are []float64.
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
			Properties map[string]any `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("not valid JSON: %v\n%s", err, rec.Body.String())
	}
	if doc.Type != "FeatureCollection" {
		t.Fatalf("type = %q", doc.Type)
	}
	path := doc.Features[0]
	if path.Geometry.Type != "LineString" {
		t.Fatalf("geometry = %q, want LineString", path.Geometry.Type)
	}
	// GeoJSON is lon,lat -- the reverse of everywhere else in this system, and
	// getting it backwards puts a flight over the Indian Ocean.
	var line [][]float64
	if err := json.Unmarshal(path.Geometry.Coordinates, &line); err != nil {
		t.Fatalf("path coordinates: %v", err)
	}
	first := line[0]
	if first[0] != -122.1 || first[1] != 46.035 {
		t.Fatalf("coordinates = %v, want [lon, lat] = [-122.1, 46.035]", first)
	}
	if first[2] != 120.5 {
		t.Fatalf("altitude missing from the position: %v", first)
	}
	if path.Properties["serial"] != "1581F5FMD24170012345" {
		t.Fatalf("serial missing from properties: %v", path.Properties)
	}
}

func TestExportCSVLeavesAbsentMeasurementsEmpty(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.store.UpsertTrack(context.Background(), flightTrack("trk-2")); err != nil {
		t.Fatal(err)
	}

	rec := exportTrack(t, h, "trk-2", "csv")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	lines := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("want a header and 2 rows, got %d lines:\n%s", len(lines), rec.Body.String())
	}
	if !strings.HasPrefix(lines[0], "track_id,at,lat,lon,alt_geodetic_m") {
		t.Fatalf("unexpected header: %q", lines[0])
	}
	// The second fix carried no altitude. A 0 there would be averaged by a
	// spreadsheet as a real sea-level reading.
	second := strings.Split(strings.TrimSpace(lines[2]), ",")
	if second[4] != "" {
		t.Fatalf("alt_geodetic_m = %q, want empty for a fix that carried none", second[4])
	}
}

func TestExportKMLIsWellFormed(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.store.UpsertTrack(context.Background(), flightTrack("trk-3")); err != nil {
		t.Fatal(err)
	}

	rec := exportTrack(t, h, "trk-3", "kml")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var any struct{}
	if err := xml.Unmarshal(rec.Body.Bytes(), &any); err != nil {
		t.Fatalf("not well-formed XML: %v\n%s", err, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "-122.1,46.035,120.5") {
		t.Fatalf("KML coordinates missing or in the wrong order:\n%s", body)
	}
}

// The one that matters. An export is a file that leaves the unit and gets
// mailed to somebody; the pilot's ground position must not ride along when the
// operator has said it should not. Every format, because a gate applied per
// formatter is a gate somebody forgets on the fourth one.
func TestExportNeverLeaksOperatorLocationWhenSuppressed(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "false"})
	if err := h.store.UpsertTrack(context.Background(), flightTrack("trk-4")); err != nil {
		t.Fatal(err)
	}

	for _, format := range []string{"geojson", "csv", "kml"} {
		rec := exportTrack(t, h, "trk-4", format)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", format, rec.Code)
		}
		body := rec.Body.String()
		for _, leak := range []string{"46.0301", "122.0902", "operator"} {
			if strings.Contains(strings.ToLower(body), strings.ToLower(leak)) {
				t.Fatalf("%s export leaked %q with operator location suppressed:\n%s", format, leak, body)
			}
		}
	}
}

func TestExportIncludesOperatorWhenExposed(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "true"})
	if err := h.store.UpsertTrack(context.Background(), flightTrack("trk-5")); err != nil {
		t.Fatal(err)
	}

	body := exportTrack(t, h, "trk-5", "geojson").Body.String()
	if !strings.Contains(body, "46.0301") {
		t.Fatalf("operator position should be present when exposed:\n%s", body)
	}
}

func TestExportRejectsAnUnknownFormatAndTrack(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.store.UpsertTrack(context.Background(), flightTrack("trk-6")); err != nil {
		t.Fatal(err)
	}

	if rec := exportTrack(t, h, "trk-6", "xlsx"); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown format: status = %d, want 400", rec.Code)
	}
	if rec := exportTrack(t, h, "no-such-track", "csv"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown track: status = %d, want 404", rec.Code)
	}
}

func TestExportOffersADownloadWithAUsableName(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.store.UpsertTrack(context.Background(), flightTrack("trk-7")); err != nil {
		t.Fatal(err)
	}

	rec := exportTrack(t, h, "trk-7", "geojson")
	disposition := rec.Header().Get("Content-Disposition")
	if !strings.Contains(disposition, `filename="classg-trk-7.geojson"`) {
		t.Fatalf("Content-Disposition = %q", disposition)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/geo+json" {
		t.Fatalf("Content-Type = %q", ct)
	}
}

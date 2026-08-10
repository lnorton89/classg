// Package storetest is a conformance suite every store.Store must pass.
//
// Two implementations exist -- memstore for tests, libSQL for deployment --
// and the failure mode worth guarding against is that they quietly disagree.
// Pagination ordering is the sharpest edge: memstore compares time.Time while
// libSQL compares formatted strings in SQL, so a format change that broke
// ordering would otherwise only show up on a Pi.
package storetest

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

// Factory builds a fresh, empty store.
type Factory func(t *testing.T) store.Store

var base = time.Date(2026, 8, 10, 14, 0, 0, 0, time.UTC)

func track(id string, lastSeen time.Time, state string, confidence float64) model.Track {
	return model.Track{
		SchemaVersion:  model.SchemaVersion,
		TrackID:        id,
		State:          state,
		FirstSeen:      lastSeen.Add(-time.Minute),
		LastSeen:       lastSeen,
		DetectionCount: 3,
		Confidence:     confidence,
		Identity:       model.TrackIdentity{Serial: "SER-" + id, MACs: []string{"aa:bb:cc:dd:ee:ff"}},
	}
}

func detection(id string, ts time.Time, sensorID, class string) model.Detection {
	d := model.Detection{
		SchemaVersion:  model.SchemaVersion,
		DetectionID:    id,
		TS:             model.FlexTime{Time: ts},
		SensorID:       sensorID,
		SensorKind:     "wifi",
		DetectionClass: class,
	}
	d.Identity.Serial = "SER-T1"
	d.Identity.MAC = "aa:bb:cc:dd:ee:ff"
	return d
}

// Run executes the whole suite against newStore.
func Run(t *testing.T, newStore Factory) {
	t.Helper()
	t.Run("TrackRoundTrip", func(t *testing.T) { testTrackRoundTrip(t, newStore) })
	t.Run("TrackFilters", func(t *testing.T) { testTrackFilters(t, newStore) })
	t.Run("TrackPagination", func(t *testing.T) { testTrackPagination(t, newStore) })
	t.Run("DetectionFilters", func(t *testing.T) { testDetectionFilters(t, newStore) })
	t.Run("TrackDetections", func(t *testing.T) { testTrackDetections(t, newStore) })
	t.Run("DetectionCounts", func(t *testing.T) { testDetectionCounts(t, newStore) })
	t.Run("Retention", func(t *testing.T) { testRetention(t, newStore) })
	t.Run("Captures", func(t *testing.T) { testCaptures(t, newStore) })
	t.Run("Config", func(t *testing.T) { testConfig(t, newStore) })
	t.Run("Sensors", func(t *testing.T) { testSensors(t, newStore) })
	t.Run("OperatorRoundTrip", func(t *testing.T) { testOperatorRoundTrip(t, newStore) })
}

func testTrackRoundTrip(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	tr := track("T1", base, "CONFIRMED", 0.8)
	tr.History = []model.Position{{Lat: 47.1, Lon: 8.1, At: base}}
	if err := s.UpsertTrack(ctx, tr); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTrack(ctx, "T1")
	if err != nil {
		t.Fatal(err)
	}
	if got.TrackID != "T1" || got.Confidence != 0.8 || len(got.History) != 1 {
		t.Fatalf("round trip lost data: %+v", got)
	}

	// Upsert must replace, not duplicate.
	tr.Confidence = 0.9
	if err := s.UpsertTrack(ctx, tr); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListTracks(ctx, store.TrackQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 {
		t.Fatalf("upsert duplicated: total=%d", page.Total)
	}
	if page.Tracks[0].Confidence != 0.9 {
		t.Fatalf("upsert did not update: %v", page.Tracks[0].Confidence)
	}

	if _, err := s.GetTrack(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing track: want ErrNotFound, got %v", err)
	}
}

func testTrackFilters(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	seed := []model.Track{
		track("T1", base, "CONFIRMED", 0.9),
		track("T2", base.Add(-time.Hour), "COASTING", 0.4),
		track("T3", base.Add(-2*time.Hour), "TENTATIVE", 0.1),
	}
	for _, tr := range seed {
		if err := s.UpsertTrack(ctx, tr); err != nil {
			t.Fatal(err)
		}
	}

	tests := []struct {
		name  string
		query store.TrackQuery
		want  []string
	}{
		{"all", store.TrackQuery{}, []string{"T1", "T2", "T3"}},
		{"state", store.TrackQuery{States: []string{"CONFIRMED", "COASTING"}}, []string{"T1", "T2"}},
		{"since", store.TrackQuery{Since: base.Add(-90 * time.Minute)}, []string{"T1", "T2"}},
		{"min_confidence", store.TrackQuery{MinConfidence: 0.5}, []string{"T1"}},
		{"combined", store.TrackQuery{States: []string{"CONFIRMED"}, MinConfidence: 0.5}, []string{"T1"}},
		{"no match", store.TrackQuery{States: []string{"CLOSED"}}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			page, err := s.ListTracks(ctx, tc.query)
			if err != nil {
				t.Fatal(err)
			}
			var ids []string
			for _, tr := range page.Tracks {
				ids = append(ids, tr.TrackID)
			}
			if !equalStrings(ids, tc.want) {
				t.Fatalf("got %v want %v", ids, tc.want)
			}
			if page.Total != len(tc.want) {
				t.Fatalf("total: got %d want %d", page.Total, len(tc.want))
			}
		})
	}
}

// testTrackPagination walks every page and asserts the union is exactly the
// seeded set. Duplicated or skipped rows are the classic keyset bug and are
// invisible if only the first page is checked.
func testTrackPagination(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	const n = 25
	for i := 0; i < n; i++ {
		// Deliberately coarse timestamps so several tracks share a last_seen
		// and the tie-break on track_id is exercised.
		ts := base.Add(-time.Duration(i/5) * time.Minute)
		if err := s.UpsertTrack(ctx, track(idFor(i), ts, "CONFIRMED", 0.5)); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]int{}
	var cursor *store.Cursor
	pages := 0
	for {
		page, err := s.ListTracks(ctx, store.TrackQuery{Limit: 7, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != n {
			t.Fatalf("total should be the unpaged count: got %d want %d", page.Total, n)
		}
		for _, tr := range page.Tracks {
			seen[tr.TrackID]++
		}
		pages++
		if pages > 10 {
			t.Fatal("pagination did not terminate")
		}
		if page.NextCursor == "" {
			break
		}
		c, err := store.DecodeCursor(page.NextCursor)
		if err != nil {
			t.Fatal(err)
		}
		cursor = &c
	}
	if len(seen) != n {
		t.Fatalf("walked %d distinct tracks, want %d", len(seen), n)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("track %s appeared %d times across pages", id, count)
		}
	}
}

func testDetectionFilters(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	seed := []model.Detection{
		detection("D1", base, "wifi-0", "A"),
		detection("D2", base.Add(-time.Minute), "wifi-0", "B"),
		detection("D3", base.Add(-2*time.Minute), "sdr-0", "E"),
	}
	for _, d := range seed {
		if err := s.InsertDetection(ctx, d); err != nil {
			t.Fatal(err)
		}
	}

	tests := []struct {
		name  string
		query store.DetectionQuery
		want  []string
	}{
		{"all", store.DetectionQuery{}, []string{"D1", "D2", "D3"}},
		{"class", store.DetectionQuery{Classes: []string{"A", "B"}}, []string{"D1", "D2"}},
		{"sensor", store.DetectionQuery{SensorID: "sdr-0"}, []string{"D3"}},
		{"since", store.DetectionQuery{Since: base.Add(-90 * time.Second)}, []string{"D1", "D2"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			page, err := s.ListDetections(ctx, tc.query)
			if err != nil {
				t.Fatal(err)
			}
			var ids []string
			for _, d := range page.Detections {
				ids = append(ids, d.DetectionID)
			}
			if !equalStrings(ids, tc.want) {
				t.Fatalf("got %v want %v", ids, tc.want)
			}
		})
	}
}

func testTrackDetections(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	inWindow := detection("D1", base, "wifi-0", "A")
	outOfWindow := detection("D2", base.Add(-time.Hour), "wifi-0", "A")
	otherAircraft := detection("D3", base, "wifi-0", "A")
	otherAircraft.Identity.Serial = "SOMEONE-ELSE"
	otherAircraft.Identity.MAC = "11:22:33:44:55:66"

	for _, d := range []model.Detection{inWindow, outOfWindow, otherAircraft} {
		if err := s.InsertDetection(ctx, d); err != nil {
			t.Fatal(err)
		}
	}

	page, err := s.ListTrackDetections(ctx, store.TrackDetectionQuery{
		Serial: "SER-T1",
		MACs:   []string{"aa:bb:cc:dd:ee:ff"},
		From:   base.Add(-time.Minute),
		To:     base.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, d := range page.Detections {
		ids = append(ids, d.DetectionID)
	}
	if !equalStrings(ids, []string{"D1"}) {
		t.Fatalf("got %v want [D1]", ids)
	}

	// A track with no identity at all cannot be joined; empty, not everything.
	page, err = s.ListTrackDetections(ctx, store.TrackDetectionQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Detections) != 0 {
		t.Fatalf("identity-less track matched %d detections, want 0", len(page.Detections))
	}
}

func testDetectionCounts(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	for _, d := range []model.Detection{
		detection("D1", base, "wifi-0", "A"),
		detection("D2", base.Add(-time.Minute), "wifi-0", "A"),
		detection("D3", base.Add(-time.Hour), "wifi-0", "A"),
		detection("D4", base, "sdr-0", "E"),
	} {
		if err := s.InsertDetection(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := s.DetectionCountsSince(ctx, base.Add(-5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if counts["wifi-0"] != 2 || counts["sdr-0"] != 1 {
		t.Fatalf("counts: %v", counts)
	}
}

func testRetention(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	if err := s.InsertDetection(ctx, detection("OLD", base.Add(-8*24*time.Hour), "wifi-0", "A")); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertDetection(ctx, detection("NEW", base, "wifi-0", "A")); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTrack(ctx, track("OLDT", base.Add(-100*24*time.Hour), "CLOSED", 0.5)); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTrack(ctx, track("NEWT", base, "CONFIRMED", 0.5)); err != nil {
		t.Fatal(err)
	}

	if _, err := s.PurgeDetections(ctx, base.Add(-7*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PurgeTracks(ctx, base.Add(-90*24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	dets, err := s.ListDetections(ctx, store.DetectionQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(dets.Detections) != 1 || dets.Detections[0].DetectionID != "NEW" {
		t.Fatalf("detection retention: %+v", dets.Detections)
	}
	tracks, err := s.ListTracks(ctx, store.TrackQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks.Tracks) != 1 || tracks.Tracks[0].TrackID != "NEWT" {
		t.Fatalf("track retention: %+v", tracks.Tracks)
	}
}

// testOperatorRoundTrip pins that the operator position survives storage.
// Whether it reaches a client is the HTTP layer's decision, but it must not be
// lost on the way in.
func testOperatorRoundTrip(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	tr := track("T1", base, "CONFIRMED", 0.9)
	tr.Operator = &model.OperatorPosition{Lat: 47.375, Lon: 8.54, At: base}
	if err := s.UpsertTrack(ctx, tr); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTrack(ctx, "T1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Operator == nil || got.Operator.Lat != 47.375 {
		t.Fatalf("operator position lost in storage: %+v", got.Operator)
	}
}

func testCaptures(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	c := model.Capture{
		CaptureID: "C1", Filename: "a.pcap", State: model.CaptureCompleted,
		StartedAt: base, Iface: "wlan1", Channel: 6, DurationS: 120,
	}
	if err := s.PutCapture(ctx, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetCaptureReport(ctx, "C1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unanalysed capture should have no report, got %v", err)
	}
	report := json.RawMessage(`{"drone_transmitters":1}`)
	if err := s.PutCaptureReport(ctx, "C1", report, model.CaptureAnalysis{Analyzed: true, DroneTransmitters: 1, ClassA: 118}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetCapture(ctx, "C1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Analysis == nil || !got.Analysis.Analyzed || got.Analysis.ClassA != 118 {
		t.Fatalf("analysis summary not stored: %+v", got.Analysis)
	}
	stored, err := s.GetCaptureReport(ctx, "C1")
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != string(report) {
		t.Fatalf("report round trip: got %s want %s", stored, report)
	}
	if _, err := s.GetCapture(ctx, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func testConfig(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	if _, err := s.GetConfig(ctx, "channels"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unset config: want ErrNotFound, got %v", err)
	}
	if err := s.PutConfig(ctx, "channels", json.RawMessage(`{"channels":[]}`)); err != nil {
		t.Fatal(err)
	}
	v, err := s.GetConfig(ctx, "channels")
	if err != nil {
		t.Fatal(err)
	}
	if string(v) != `{"channels":[]}` {
		t.Fatalf("config round trip: %s", v)
	}
	if err := s.PutConfig(ctx, "channels", json.RawMessage(`{"channels":[1]}`)); err != nil {
		t.Fatal(err)
	}
	v, _ = s.GetConfig(ctx, "channels")
	if string(v) != `{"channels":[1]}` {
		t.Fatalf("config not overwritten: %s", v)
	}
}

func testSensors(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	if err := s.UpsertSensor(ctx, store.SensorRecord{
		SensorID: "wifi-0", SensorKind: "wifi", LastHeartbeat: base, Healthy: true,
		Detail: map[string]any{"channel": float64(6)},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertSensor(ctx, store.SensorRecord{
		SensorID: "sdr-0", SensorKind: "sdr", LastHeartbeat: base, Healthy: false, Reason: "device not found",
	}); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListSensors(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 sensors, got %d", len(list))
	}
	if list[0].SensorID != "sdr-0" || list[1].SensorID != "wifi-0" {
		t.Fatalf("sensors should be ordered by id: %+v", list)
	}
	if list[0].Reason != "device not found" {
		t.Fatalf("reason lost: %+v", list[0])
	}
	if !list[1].LastHeartbeat.Equal(base) {
		t.Fatalf("heartbeat time lost: %v want %v", list[1].LastHeartbeat, base)
	}
}

func idFor(i int) string {
	return string(rune('A'+i/26)) + string(rune('a'+i%26))
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

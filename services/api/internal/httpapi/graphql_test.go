package httpapi_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
)

// gql posts a query and returns the decoded envelope.
func gql(t *testing.T, h *harness, query string) gqlResponse {
	t.Helper()
	body, err := json.Marshal(map[string]any{"query": query})
	if err != nil {
		t.Fatal(err)
	}
	w := h.do(t, "POST", "/api/v1/graphql", string(body))
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200; body %s", w.Code, w.Body.String())
	}
	var out gqlResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decoding the response: %v; body %s", err, w.Body.String())
	}
	return out
}

type gqlResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func (r gqlResponse) firstError() string {
	if len(r.Errors) == 0 {
		return ""
	}
	return r.Errors[0].Message
}

func (r gqlResponse) mustSucceed(t *testing.T) gqlResponse {
	t.Helper()
	if len(r.Errors) > 0 {
		t.Fatalf("query failed: %s", r.firstError())
	}
	return r
}

func TestGraphQLReadsTracks(t *testing.T) {
	h := newHarness(t, nil)
	seedTrack(t, h, "trk-1", base, false)

	got := gql(t, h, `{ tracks(limit: 10) { total tracks { track_id state confidence } } }`).
		mustSucceed(t)

	var out struct {
		Tracks struct {
			Total  int `json:"total"`
			Tracks []struct {
				TrackID    string  `json:"track_id"`
				State      string  `json:"state"`
				Confidence float64 `json:"confidence"`
			} `json:"tracks"`
		} `json:"tracks"`
	}
	if err := json.Unmarshal(got.Data, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Tracks.Tracks) != 1 || out.Tracks.Tracks[0].TrackID != "trk-1" {
		t.Fatalf("tracks = %+v", out.Tracks.Tracks)
	}
	if out.Tracks.Tracks[0].State != "CONFIRMED" || out.Tracks.Tracks[0].Confidence != 0.82 {
		t.Errorf("fields did not survive the round trip: %+v", out.Tracks.Tracks[0])
	}
}

// The whole reason the endpoint exists: tracks and their detections without a
// call per track.
func TestGraphQLNestsDetectionsUnderTrack(t *testing.T) {
	h := newHarness(t, nil)
	h.ingestDetection(t, sampleDetection("det-1"))

	tr := model.Track{
		SchemaVersion: model.SchemaVersion, TrackID: "trk-nest", State: "CONFIRMED",
		FirstSeen: time.Date(2026, 8, 11, 3, 0, 0, 0, time.UTC),
		LastSeen:  time.Date(2026, 8, 11, 5, 0, 0, 0, time.UTC),
		Identity:  model.TrackIdentity{Serial: "1581F0000000FAKE0001"},
	}
	if err := h.store.UpsertTrack(t.Context(), tr); err != nil {
		t.Fatal(err)
	}

	got := gql(t, h, `{ tracks { tracks { track_id detections(limit: 5) { detections { detection_id sensor_kind } } } } }`).
		mustSucceed(t)

	if !strings.Contains(string(got.Data), "det-1") {
		t.Fatalf("the nested detections did not resolve: %s", got.Data)
	}
}

// The operator's ground position is personal data and leaves the unit only
// through an explicit allowlist. GraphQL is a second read path over the same
// rows, so it has to honour the same switch -- and no REST test can prove that
// it does.
func TestGraphQLRedactsOperatorPositionByDefault(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "false"})
	seedTrack(t, h, "trk-op", base, true)

	got := gql(t, h, `{ tracks { tracks { track_id operator { lat lon } } } }`).mustSucceed(t)
	if strings.Contains(string(got.Data), "47.375") {
		t.Fatalf("the operator's position reached a client through GraphQL: %s", got.Data)
	}

	// And the same query on a unit configured to expose it does return it, so
	// the test above is proving redaction rather than a field that never works.
	h2 := newHarness(t, map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "true"})
	seedTrack(t, h2, "trk-op", base, true)
	got2 := gql(t, h2, `{ tracks { tracks { operator { lat } } } }`).mustSucceed(t)
	if !strings.Contains(string(got2.Data), "47.375") {
		t.Fatalf("operator position was withheld even when configured to expose: %s", got2.Data)
	}
}

// Admin data has no resolver at all. If one is ever added, this fails.
func TestGraphQLHasNoAdminSurface(t *testing.T) {
	h := newHarness(t, nil)
	for _, field := range []string{"users", "sessions", "hooks", "hook_deliveries", "deployment"} {
		got := gql(t, h, `{ `+field+` { __typename } }`)
		if len(got.Errors) == 0 {
			t.Errorf("query { %s } resolved; the admin surface must stay off GraphQL", field)
		}
	}
}

func TestGraphQLRejectsDeepQueries(t *testing.T) {
	h := newHarness(t, nil)
	seedTrack(t, h, "trk-deep", base, false)

	// The schema itself has no cycle, so its deepest real path is six. This
	// document nests past the ceiling using field names that do not exist --
	// which is the point: cost is refused BEFORE validation, so a client
	// cannot make this unit walk a huge document just to be told the fields
	// were wrong.
	deep := `{ tracks { tracks { detections { detections { a { b { c { d { e } } } } } } } } }`
	got := gql(t, h, deep)
	if len(got.Errors) == 0 {
		t.Fatalf("a query past the depth limit executed: %s", got.Data)
	}
	if !strings.Contains(got.firstError(), "levels deep") {
		t.Errorf("error = %q, want the depth message", got.firstError())
	}
}

func TestGraphQLRejectsTooManyTopLevelFields(t *testing.T) {
	h := newHarness(t, nil)

	var b strings.Builder
	b.WriteString("{")
	for i := range 40 {
		b.WriteString(" a")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(string(rune('a' + i/26)))
		b.WriteString(": health { status }")
	}
	b.WriteString(" }")

	got := gql(t, h, b.String())
	if len(got.Errors) == 0 {
		t.Fatal("a query with 40 top-level fields executed")
	}
	if !strings.Contains(got.firstError(), "top-level fields") {
		t.Errorf("error = %q, want the width message", got.firstError())
	}
}

// A GET carrying a query would be cached and logged by everything in the path,
// and detections carry positions.
func TestGraphQLRefusesGET(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(t, "GET", "/api/v1/graphql?query={health{status}}", "")
	if w.Code == 200 {
		t.Fatalf("GET was served: %s", w.Body.String())
	}
}

func TestGraphQLReportsHealthAndSystem(t *testing.T) {
	h := newHarness(t, nil)
	got := gql(t, h, `{ health { status version } system { build { version } runtime { containerised } } }`).
		mustSucceed(t)
	if !strings.Contains(string(got.Data), `"status"`) {
		t.Fatalf("health did not resolve: %s", got.Data)
	}
}

// A unit with no SDR reports why rather than failing the query (ADR-0003).
func TestGraphQLBandsDegradeWithoutARadio(t *testing.T) {
	h := newHarness(t, nil)
	got := gql(t, h, `{ bands { available reason bands { name } } }`).mustSucceed(t)

	var out struct {
		Bands struct {
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"bands"`
	}
	if err := json.Unmarshal(got.Data, &out); err != nil {
		t.Fatal(err)
	}
	if out.Bands.Available {
		t.Error("available is true on a harness with no sweep engine")
	}
	if out.Bands.Reason == "" {
		t.Error("unavailable with no reason sends an operator looking for a fault that is not there")
	}
}

// Frequencies pass 2^31 at 2.4 GHz, where GraphQL's 32-bit Int truncates.
func TestGraphQLFrequenciesSurviveAs64Bit(t *testing.T) {
	h := newHarness(t, nil)
	freq := int64(5_805_000_000)
	body := `{
		"schema_version": "1.0",
		"detection_id": "det-hz",
		"ts": "2026-08-11T04:00:00.000Z",
		"sensor_id": "wifi-0",
		"sensor_kind": "wifi",
		"detection_class": "A",
		"rf": {"freq_hz": 5805000000}
	}`
	h.ingestDetection(t, []byte(body))

	got := gql(t, h, `{ detections { detections { detection_id rf { freq_hz } } } }`).mustSucceed(t)
	want := `"freq_hz":"5805000000"`
	if !strings.Contains(strings.ReplaceAll(string(got.Data), " ", ""), want) {
		t.Fatalf("frequency did not survive: %s (want %s, from %d)", got.Data, want, freq)
	}
}

// An unknown filter value is refused rather than quietly returning nothing:
// zero rows for state=CONFIRMD looks exactly like a quiet sky.
func TestGraphQLRejectsUnknownTrackState(t *testing.T) {
	h := newHarness(t, nil)
	got := gql(t, h, `{ tracks(states: ["CONFIRMD"]) { total } }`)
	if len(got.Errors) == 0 {
		t.Fatal("a misspelled state was accepted")
	}
	if !strings.Contains(got.firstError(), "CONFIRMD") {
		t.Errorf("error = %q, want it to name the bad value", got.firstError())
	}
}

// A missing row is null, not an error: a client asking for several ids at once
// must not see one miss fail the whole query.
func TestGraphQLMissingTrackIsNull(t *testing.T) {
	h := newHarness(t, nil)
	got := gql(t, h, `{ track(track_id: "nope") { track_id } }`).mustSucceed(t)
	if !strings.Contains(string(got.Data), `"track":null`) {
		t.Fatalf("data = %s, want a null track", got.Data)
	}
}

// MaxDepth and MaxAliases bound a query's SHAPE; neither stopped
// tracks(limit: 1000) with detections sub-selected, which is ~2001 sequential
// store queries on the single database connection, against live ingest.
func TestGraphQLRefusesWideTrackPagesWithDetections(t *testing.T) {
	h := newHarness(t, nil)
	seedTrack(t, h, "trk-fan", base, false)

	got := gql(t, h, `{ tracks(limit: 1000) { tracks { track_id detections { detections { detection_id } } } } }`)
	if len(got.Errors) == 0 {
		t.Fatalf("a 1000-track fan-out executed: %s", got.Data)
	}
	if !strings.Contains(got.firstError(), "tracks per page when detections are selected") {
		t.Errorf("error = %q, want the fan-out message", got.firstError())
	}

	// The same width WITHOUT detections stays legal -- one query, one page.
	if got := gql(t, h, `{ tracks(limit: 1000) { tracks { track_id } } }`); len(got.Errors) != 0 {
		t.Fatalf("a plain 1000-track page was refused: %s", got.firstError())
	}
	// And detections under a paginable width stays legal.
	if got := gql(t, h, `{ tracks(limit: 100) { tracks { track_id detections { detections { detection_id } } } } }`); len(got.Errors) != 0 {
		t.Fatalf("a 100-track fan-out was refused: %s", got.firstError())
	}
}

// The budget cannot be dodged by moving the limit into a variable: checkCost
// resolves variables before deciding.
func TestGraphQLFanOutBudgetSeesVariables(t *testing.T) {
	h := newHarness(t, nil)

	body, err := json.Marshal(map[string]any{
		"query":     `query($n: Int) { tracks(limit: $n) { tracks { detections { total } } } }`,
		"variables": map[string]any{"n": 1000},
	})
	if err != nil {
		t.Fatal(err)
	}
	w := h.do(t, "POST", "/api/v1/graphql", string(body))
	var out gqlResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) == 0 {
		t.Fatal("limit: $n with n=1000 slipped past the fan-out budget")
	}
}

// Skipping the count when total is not selected must not change what a client
// that DOES select total sees.
func TestGraphQLTrackDetectionsTotalStillWorks(t *testing.T) {
	h := newHarness(t, nil)
	h.ingestDetection(t, sampleDetection("det-tot"))

	tr := model.Track{
		SchemaVersion: model.SchemaVersion, TrackID: "trk-tot", State: "CONFIRMED",
		FirstSeen: time.Date(2026, 8, 11, 3, 0, 0, 0, time.UTC),
		LastSeen:  time.Date(2026, 8, 11, 5, 0, 0, 0, time.UTC),
		Identity:  model.TrackIdentity{Serial: "1581F0000000FAKE0001"},
	}
	if err := h.store.UpsertTrack(t.Context(), tr); err != nil {
		t.Fatal(err)
	}

	got := gql(t, h, `{ tracks { tracks { detections { total detections { detection_id } } } } }`).
		mustSucceed(t)
	var out struct {
		Tracks struct {
			Tracks []struct {
				Detections struct {
					Total      int `json:"total"`
					Detections []struct {
						DetectionID string `json:"detection_id"`
					} `json:"detections"`
				} `json:"detections"`
			} `json:"tracks"`
		} `json:"tracks"`
	}
	if err := json.Unmarshal(got.Data, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Tracks.Tracks) != 1 || out.Tracks.Tracks[0].Detections.Total != 1 {
		t.Fatalf("total did not survive the count-skipping change: %s", got.Data)
	}
}

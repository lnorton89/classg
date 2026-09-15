package httpapi_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

// --- the track window ------------------------------------------------------

// `until` closes the window `since` opens. Both bounds are inclusive, because
// the control that produces them is a day picked off the flights-per-day
// histogram -- a flight that ended at 23:59:59 belongs to that day.
func TestTracksUntilClosesTheWindow(t *testing.T) {
	h := newHarness(t, nil)
	seedTrack(t, h, "OLD", base.Add(-2*time.Hour), false)
	seedTrack(t, h, "EDGE", base.Add(-time.Hour), false)
	seedTrack(t, h, "NEW", base, false)

	tests := []struct {
		name  string
		query string
		want  []string
	}{
		{"until alone", "?until=" + rfc(base.Add(-time.Hour)), []string{"EDGE", "OLD"}},
		{"since and until", "?since=" + rfc(base.Add(-time.Hour)) + "&until=" + rfc(base.Add(-time.Hour)),
			[]string{"EDGE"}},
		{"no until is unbounded", "?since=" + rfc(base.Add(-time.Hour)), []string{"NEW", "EDGE"}},
		{"window with nothing in it", "?since=" + rfc(base.Add(time.Hour)) + "&until=" + rfc(base.Add(2*time.Hour)), nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, total := listTrackIDs(t, h, tc.query)
			if !sameIDs(got, tc.want) {
				t.Fatalf("tracks: got %v want %v", got, tc.want)
			}
			if total != len(tc.want) {
				t.Fatalf("total: got %d want %d", total, len(tc.want))
			}
		})
	}
}

// --- identity facets -------------------------------------------------------

func TestTracksSerialAndVendorFilters(t *testing.T) {
	h := newHarness(t, nil)
	seedIdentifiedTrack(t, h, "T1", base, "SER-A", "dji")
	seedIdentifiedTrack(t, h, "T2", base.Add(-time.Hour), "SER-A", "DJI")
	seedIdentifiedTrack(t, h, "T3", base.Add(-2*time.Hour), "SER-B", "autel")

	tests := []struct {
		name  string
		query string
		want  []string
	}{
		{"serial", "?serial=SER-B", []string{"T3"}},
		{"serial is exact", "?serial=SER", nil},
		// Vendor is whatever the airframe broadcast, so the case an operator
		// saw on the detail page must not decide whether the chip works.
		{"vendor lowercase", "?vendor=dji", []string{"T1", "T2"}},
		{"vendor uppercase", "?vendor=DJI", []string{"T1", "T2"}},
		{"vendor mixed case", "?vendor=dJi", []string{"T1", "T2"}},
		{"serial and vendor", "?serial=SER-A&vendor=autel", nil},
		// An empty value is no filter at all -- a UI that always sends the
		// param must not get zero rows for an unset chip.
		{"empty serial is unfiltered", "?serial=", []string{"T1", "T2", "T3"}},
		{"empty vendor is unfiltered", "?vendor=", []string{"T1", "T2", "T3"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, total := listTrackIDs(t, h, tc.query)
			if !sameIDs(got, tc.want) {
				t.Fatalf("tracks: got %v want %v", got, tc.want)
			}
			if total != len(tc.want) {
				t.Fatalf("total: got %d want %d", total, len(tc.want))
			}
		})
	}
}

// A serial with no vendor recorded is the pre-Basic-ID state, and it must not
// fall into every vendor filter through a NULL comparison.
func TestVendorFilterSkipsTracksWithNoVendor(t *testing.T) {
	h := newHarness(t, nil)
	seedIdentifiedTrack(t, h, "NAMED", base, "SER-A", "dji")
	seedIdentifiedTrack(t, h, "ANON", base.Add(-time.Hour), "SER-B", "")

	got, _ := listTrackIDs(t, h, "?vendor=dji")
	if !sameIDs(got, []string{"NAMED"}) {
		t.Fatalf("got %v want [NAMED]", got)
	}
}

// --- labels ----------------------------------------------------------------

func TestAircraftLabelRoundTrip(t *testing.T) {
	h := newHarness(t, nil)

	w := h.do(t, "PUT", "/api/v1/aircraft/SER-A/label",
		`{"label":"Neighbour's Mini 4 Pro","flag":"known"}`)
	if w.Code != 200 {
		t.Fatalf("put: status %d (%s)", w.Code, w.Body.String())
	}
	var put store.AircraftLabel
	if err := json.Unmarshal(w.Body.Bytes(), &put); err != nil {
		t.Fatal(err)
	}
	if put.Serial != "SER-A" || put.Label != "Neighbour's Mini 4 Pro" || put.Flag != "known" {
		t.Fatalf("put echoed %+v", put)
	}
	if put.UpdatedAt.IsZero() {
		t.Fatal("a stored label must carry when it was written")
	}

	w = h.do(t, "GET", "/api/v1/aircraft/SER-A/label", "")
	if w.Code != 200 {
		t.Fatalf("get: status %d (%s)", w.Code, w.Body.String())
	}
	var got store.AircraftLabel
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Label != put.Label || got.Flag != put.Flag {
		t.Fatalf("get returned %+v, want %+v", got, put)
	}

	w = h.do(t, "GET", "/api/v1/aircraft/labels", "")
	if w.Code != 200 {
		t.Fatalf("list: status %d (%s)", w.Code, w.Body.String())
	}
	var list struct {
		Labels []store.AircraftLabel `json:"labels"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Labels) != 1 || list.Labels[0].Serial != "SER-A" {
		t.Fatalf("list: %+v", list.Labels)
	}
}

// An empty label with an empty flag is how the UI clears one, so it must
// delete the row rather than storing a blank that lists as a labelled
// aircraft with nothing to show.
func TestEmptyAircraftLabelDeletes(t *testing.T) {
	h := newHarness(t, nil)
	if w := h.do(t, "PUT", "/api/v1/aircraft/SER-A/label", `{"label":"gone soon","flag":"watch"}`); w.Code != 200 {
		t.Fatalf("seed: status %d (%s)", w.Code, w.Body.String())
	}

	w := h.do(t, "PUT", "/api/v1/aircraft/SER-A/label", `{"label":"","flag":""}`)
	if w.Code != 204 {
		t.Fatalf("clear: status %d (%s)", w.Code, w.Body.String())
	}
	if body := w.Body.String(); body != "" {
		t.Fatalf("204 must carry no body, got %q", body)
	}

	if w := h.do(t, "GET", "/api/v1/aircraft/SER-A/label", ""); w.Code != 404 {
		t.Fatalf("after clearing: status %d, want 404", w.Code)
	}
	// Clearing twice is the state the caller asked for, not an error.
	if w := h.do(t, "PUT", "/api/v1/aircraft/SER-A/label", `{"label":"","flag":""}`); w.Code != 204 {
		t.Fatalf("second clear: status %d (%s)", w.Code, w.Body.String())
	}

	w = h.do(t, "GET", "/api/v1/aircraft/labels", "")
	if !strings.Contains(w.Body.String(), `"labels":[]`) {
		t.Fatalf("cleared label still listed: %s", w.Body.String())
	}
}

// A flag on its own, with no name, is a legitimate state: an operator can
// triage an aircraft without thinking of a name for it.
func TestAircraftFlagWithoutALabel(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(t, "PUT", "/api/v1/aircraft/SER-A/label", `{"label":"","flag":"ignore"}`)
	if w.Code != 200 {
		t.Fatalf("status %d (%s)", w.Code, w.Body.String())
	}
	if w := h.do(t, "GET", "/api/v1/aircraft/SER-A/label", ""); w.Code != 200 {
		t.Fatalf("flag-only label was not stored: status %d", w.Code)
	}
}

func TestAircraftLabelValidation(t *testing.T) {
	h := newHarness(t, nil)

	tests := []struct {
		name, path, body string
		wantStatus       int
		wantField        string
	}{
		{"unknown flag", "/api/v1/aircraft/SER-A/label", `{"flag":"jam"}`, 400, "flag"},
		{"label too long", "/api/v1/aircraft/SER-A/label",
			`{"label":"` + strings.Repeat("x", 121) + `"}`, 400, "label"},
		{"serial too long", "/api/v1/aircraft/" + strings.Repeat("S", 65) + "/label",
			`{"label":"x"}`, 400, "serial"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := h.do(t, "PUT", tc.path, tc.body)
			if w.Code != tc.wantStatus {
				t.Fatalf("status: got %d want %d (%s)", w.Code, tc.wantStatus, w.Body.String())
			}
			if f := decodeErr(t, w).Error.Field; f != tc.wantField {
				t.Fatalf("field: got %q want %q", f, tc.wantField)
			}
		})
	}

	// At the limit, not over it.
	w := h.do(t, "PUT", "/api/v1/aircraft/SER-A/label",
		`{"label":"`+strings.Repeat("x", 120)+`"}`)
	if w.Code != 200 {
		t.Fatalf("a label at the maximum length was refused: %d (%s)", w.Code, w.Body.String())
	}
}

// Labelling a serial no track has carried is allowed. Requiring a sighting
// first would make the feature useless on a unit that has just been switched
// on, which is exactly when an operator knows what they expect to see.
func TestAircraftLabelForAnUnseenSerial(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(t, "PUT", "/api/v1/aircraft/SER-NEVER-SEEN/label", `{"label":"not yet flown"}`)
	if w.Code != 200 {
		t.Fatalf("status %d (%s)", w.Code, w.Body.String())
	}
}

// --- helpers ---------------------------------------------------------------

func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func seedIdentifiedTrack(t *testing.T, h *harness, id string, lastSeen time.Time, serial, vendor string) {
	t.Helper()
	tr := seedTrack(t, h, id, lastSeen, false)
	tr.Identity.Serial = serial
	tr.Identity.Vendor = vendor
	if err := h.store.UpsertTrack(t.Context(), tr); err != nil {
		t.Fatal(err)
	}
}

func listTrackIDs(t *testing.T, h *harness, query string) ([]string, int) {
	t.Helper()
	w := h.do(t, "GET", "/api/v1/tracks"+query, "")
	if w.Code != 200 {
		t.Fatalf("GET /tracks%s: status %d (%s)", query, w.Code, w.Body.String())
	}
	var resp struct {
		Tracks []model.Track `json:"tracks"`
		Total  int           `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, tr := range resp.Tracks {
		ids = append(ids, tr.TrackID)
	}
	return ids, resp.Total
}

func sameIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

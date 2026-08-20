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
	"fmt"
	"testing"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/hooks"
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
	t.Run("Telemetry", func(t *testing.T) { testTelemetry(t, newStore) })
	t.Run("Sweeps", func(t *testing.T) { testSweeps(t, newStore) })
	t.Run("Users", func(t *testing.T) { testUsers(t, newStore) })
	t.Run("Sessions", func(t *testing.T) { testSessions(t, newStore) })
	t.Run("SkipTotal", func(t *testing.T) { testSkipTotal(t, newStore) })
	t.Run("HookRuleFired", func(t *testing.T) { testHookRuleFired(t, newStore) })
	t.Run("LastSeenBefore", func(t *testing.T) { testLastSeenBefore(t, newStore) })
	t.Run("SessionRevocation", func(t *testing.T) { testSessionRevocation(t, newStore) })
	t.Run("HookRulesAndDeliveries", func(t *testing.T) { testHookRulesAndDeliveries(t, newStore) })
}

// Hook rules and deliveries were implemented in both stores with nothing
// holding them to the same answers. The dispatcher reads rules on every event
// and caches them, and deliveries are the audit trail an operator uses to work
// out why a page did or did not arrive -- both are worth more than "it compiled
// twice".
//
// The limit rule is the same one ListSessions got wrong: non-positive means no
// limit, in both stores.
func testHookRulesAndDeliveries(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	rule := hooks.Rule{
		RuleID: "r-keep", Name: "keep", Enabled: true,
		Event: "track.confirmed", Action: "webhook",
		Config:    map[string]any{"url": "https://example.invalid/h"},
		CreatedAt: base, UpdatedAt: base,
	}
	other := rule
	other.RuleID, other.Name = "r-drop", "drop"
	for _, r := range []hooks.Rule{rule, other} {
		if err := s.PutHookRule(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	rules, err := s.ListHookRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 2 {
		t.Fatalf("ListHookRules returned %d, want 2", len(rules))
	}

	if err := s.DeleteHookRule(ctx, "r-drop"); err != nil {
		t.Fatal(err)
	}
	rules, err = s.ListHookRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 1 || rules[0].RuleID != "r-keep" {
		t.Fatalf("after delete: %+v, want only r-keep", rules)
	}
	// Deleting something already gone must not report success in one store and
	// an error in the other.
	if err := s.DeleteHookRule(ctx, "r-drop"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("deleting a missing rule returned %v, want ErrNotFound", err)
	}

	for i := 0; i < 250; i++ {
		d := hooks.Delivery{
			DeliveryID: fmt.Sprintf("d-%d", i), RuleID: "r-keep", Event: "track.confirmed",
			CreatedAt: base.Add(time.Duration(i) * time.Second), Status: "delivered", Attempts: 1,
		}
		if err := s.PutHookDelivery(ctx, d); err != nil {
			t.Fatal(err)
		}
	}

	all, err := s.ListHookDeliveries(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 250 {
		t.Fatalf("limit 0 returned %d deliveries, want all 250", len(all))
	}
	if !all[0].CreatedAt.After(all[len(all)-1].CreatedAt) {
		t.Error("deliveries must come back newest first")
	}
	page, err := s.ListHookDeliveries(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 10 {
		t.Fatalf("limit 10 returned %d deliveries, want 10", len(page))
	}

	n, err := s.PurgeHookDeliveries(ctx, base.Add(100*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if n != 100 {
		t.Fatalf("purged %d deliveries, want the 100 strictly older than the cutoff", n)
	}
}

// A non-positive limit to ListSessions means NO limit, and both stores must
// agree, because revocation is built on it.
//
// auth.revokeExcept lists sessions with limit 0 to delete every OTHER session
// after a password change. libsqlstore used to substitute 200 while memstore
// returned everything, and the query is newest-active first -- so a stolen
// session sitting idle sorted below the cutoff, was never listed, and survived
// the password change that was supposed to kill it. Only in production.
func testSessionRevocation(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	// More sessions than any cap a store might invent, with the target user's
	// session deliberately the LEAST recently active so a truncating
	// implementation drops exactly the one that matters.
	// Both users are real: libsqlstore enforces sessions.user_id as a foreign
	// key and memstore does not, so a fixture that skips this passes in one
	// store and fails in the other.
	for _, id := range []string{"victim", "someone-else"} {
		if err := s.PutUser(ctx, auth.User{
			UserID: id, Username: id, Role: auth.RoleViewer,
			CreatedAt: base, UpdatedAt: base,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mkSession := func(id, userID string, lastSeen time.Time) auth.Session {
		return auth.Session{
			SessionID: id, UserID: userID,
			CreatedAt: base, ExpiresAt: base.Add(24 * time.Hour), LastSeen: lastSeen,
		}
	}
	if err := s.PutSession(ctx, mkSession("stale-but-live", "victim", base.Add(-48*time.Hour))); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 250; i++ {
		if err := s.PutSession(ctx, mkSession(
			fmt.Sprintf("noise-%d", i), "someone-else", base.Add(time.Duration(i)*time.Second),
		)); err != nil {
			t.Fatal(err)
		}
	}

	all, err := s.ListSessions(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 251 {
		t.Fatalf("limit 0 returned %d sessions, want all 251 -- a store that caps here leaves sessions unrevoked", len(all))
	}
	found := false
	for _, sess := range all {
		if sess.SessionID == "stale-but-live" {
			found = true
		}
	}
	if !found {
		t.Error("the least recently active session was missing; revocation would never see it")
	}

	// And an explicit positive limit is still honoured.
	page, err := s.ListSessions(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 10 {
		t.Fatalf("limit 10 returned %d sessions, want 10", len(page))
	}
}

// LastSeenBefore decides which tracks the stale sweep closes, so the two
// implementations disagreeing means dev closes a different set to production.
// Strictly older, in both: a track whose last_seen is EXACTLY the cutoff is not
// yet stale, and the sweep runs on a timer against a cutoff computed from the
// same clock -- an inclusive comparison in one store would close a track the
// other left open, which is a phantom drone on one map and not the other.
func testLastSeenBefore(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)
	cutoff := base.Add(-5 * time.Minute)
	for _, tr := range []model.Track{
		track("OLD", cutoff.Add(-time.Second), "CONFIRMED", 0.9),
		track("EXACT", cutoff, "CONFIRMED", 0.9),
		track("FRESH", cutoff.Add(time.Second), "CONFIRMED", 0.9),
	} {
		if err := s.UpsertTrack(ctx, tr); err != nil {
			t.Fatal(err)
		}
	}

	page, err := s.ListTracks(ctx, store.TrackQuery{LastSeenBefore: cutoff})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, tr := range page.Tracks {
		got[tr.TrackID] = true
	}
	if !got["OLD"] {
		t.Error("a track older than the cutoff must be returned as stale")
	}
	if got["EXACT"] {
		t.Error("a track exactly at the cutoff is not yet stale; the comparison must be strict")
	}
	if got["FRESH"] {
		t.Error("a track newer than the cutoff must not be returned")
	}

	// Absent means unfiltered, not "before the zero time".
	all, err := s.ListTracks(ctx, store.TrackQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Tracks) != 3 {
		t.Fatalf("unfiltered returned %d tracks, want 3", len(all.Tracks))
	}
}

// SkipTotal means "do not run the count", and both implementations must agree
// on what the caller then sees: zero, not a free answer one of them happens to
// have lying around.
func testSkipTotal(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)
	for _, tr := range []model.Track{track("T1", base, "CONFIRMED", 0.9), track("T2", base.Add(-time.Hour), "COASTING", 0.4)} {
		if err := s.UpsertTrack(ctx, tr); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.InsertDetection(ctx, detection("D1", base, "wifi-0", "A")); err != nil {
		t.Fatal(err)
	}

	page, err := s.ListTracks(ctx, store.TrackQuery{SkipTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Tracks) != 2 || page.Total != 0 {
		t.Fatalf("tracks=%d total=%d, want rows with a zero total", len(page.Tracks), page.Total)
	}

	dpage, err := s.ListTrackDetections(ctx, store.TrackDetectionQuery{Serial: "SER-T1", SkipTotal: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(dpage.Detections) != 1 || dpage.Total != 0 {
		t.Fatalf("detections=%d total=%d, want rows with a zero total", len(dpage.Detections), dpage.Total)
	}
}

// MarkHookRuleFired is a targeted update: it must bump the counter and stamp
// the time without disturbing the rest of the document, however stale a copy
// the caller happens to hold.
func testHookRuleFired(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	rule := hooks.Rule{
		RuleID: "r1", Name: "confirmed drones", Enabled: true,
		Event: "track.confirmed", Action: "webhook",
		Config:    map[string]any{"url": "https://example.com/hook"},
		CooldownS: 300,
		CreatedAt: base, UpdatedAt: base,
	}
	if err := s.PutHookRule(ctx, rule); err != nil {
		t.Fatal(err)
	}

	firedAt := base.Add(time.Minute)
	if err := s.MarkHookRuleFired(ctx, "r1", firedAt); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkHookRuleFired(ctx, "r1", firedAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetHookRule(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if got.FireCount != 2 {
		t.Fatalf("fire_count = %d, want 2", got.FireCount)
	}
	if got.LastFiredAt == nil || !got.LastFiredAt.Equal(firedAt.Add(time.Minute)) {
		t.Fatalf("last_fired_at = %v", got.LastFiredAt)
	}
	// The rest of the document is untouched -- this is what the targeted
	// update buys over a read-modify-write of the whole doc.
	if got.Name != rule.Name || got.CooldownS != rule.CooldownS || got.Config["url"] != rule.Config["url"] {
		t.Fatalf("firing disturbed the rule document: %+v", got)
	}

	if err := s.MarkHookRuleFired(ctx, "no-such-rule", firedAt); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing rule: got %v, want ErrNotFound", err)
	}
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
		{"last_seen_before", store.TrackQuery{LastSeenBefore: base.Add(-30 * time.Minute)}, []string{"T2", "T3"}},
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

// Telemetry's sharp edge is nullability. Every host reading can be unreadable,
// and a store that turns a nil into 0 on the way through would put a cold Pi
// on a chart instead of a gap -- silently, and only on the implementation that
// did it.
func testTelemetry(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	temp, load := 46.25, 0.69
	mem, disk, up := int64(3409708), int64(92687323136), int64(12167)

	full := store.TelemetrySample{
		TS: base, CPUTempC: &temp, Load1: &load,
		MemAvailableKB: &mem, DiskFreeBytes: &disk, UptimeS: &up,
		Sensors: []store.TelemetrySensor{{
			SensorID: "wifi-0", SensorKind: "wifi", Healthy: true,
			Metrics: map[string]float64{"beacons": 15886, "listening_fraction": 0.74},
		}},
	}
	// Everything unreadable: the shape a container that cannot see /sys gives.
	empty := store.TelemetrySample{TS: base.Add(time.Minute)}

	for _, sample := range []store.TelemetrySample{full, empty} {
		if err := s.InsertTelemetry(ctx, sample); err != nil {
			t.Fatal(err)
		}
	}
	// A restart inside one sampling interval must not fail the api.
	if err := s.InsertTelemetry(ctx, full); err != nil {
		t.Fatalf("re-inserting an existing timestamp should be ignored, got %v", err)
	}

	got, err := s.ListTelemetry(ctx, store.TelemetryQuery{
		Since: base.Add(-time.Hour), Until: base.Add(time.Hour), Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 samples, got %d", len(got))
	}
	if !got[0].TS.Equal(base) {
		t.Fatalf("samples must come back oldest first: %+v", got[0].TS)
	}

	if got[0].CPUTempC == nil || *got[0].CPUTempC != temp {
		t.Fatalf("cpu_temp_c = %v, want %v", got[0].CPUTempC, temp)
	}
	if got[0].DiskFreeBytes == nil || *got[0].DiskFreeBytes != disk {
		t.Fatalf("disk_free_bytes = %v, want %v", got[0].DiskFreeBytes, disk)
	}
	if got[0].UptimeS == nil || *got[0].UptimeS != up {
		t.Fatalf("uptime_s = %v, want %v", got[0].UptimeS, up)
	}
	if len(got[0].Sensors) != 1 || got[0].Sensors[0].Metrics["beacons"] != 15886 {
		t.Fatalf("sensor metrics lost: %+v", got[0].Sensors)
	}

	// The row that matters: nils must still be nils.
	for name, v := range map[string]any{
		"cpu_temp_c": got[1].CPUTempC, "load1": got[1].Load1,
		"mem_available_kb": got[1].MemAvailableKB, "disk_free_bytes": got[1].DiskFreeBytes,
		"uptime_s": got[1].UptimeS,
	} {
		if !isNilPtr(v) {
			t.Fatalf("%s came back as %v; an unreadable figure must stay null", name, v)
		}
	}

	// Windowing excludes what falls outside it.
	narrow, err := s.ListTelemetry(ctx, store.TelemetryQuery{
		Since: base.Add(30 * time.Second), Until: base.Add(time.Hour), Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(narrow) != 1 {
		t.Fatalf("want 1 sample inside the narrowed window, got %d", len(narrow))
	}

	n, err := s.PurgeTelemetry(ctx, base.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged %d rows, want 1", n)
	}
	left, err := s.ListTelemetry(ctx, store.TelemetryQuery{
		Since: base.Add(-time.Hour), Until: base.Add(time.Hour), Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 1 {
		t.Fatalf("want 1 sample left after the purge, got %d", len(left))
	}
}

func isNilPtr(v any) bool {
	switch p := v.(type) {
	case *float64:
		return p == nil
	case *int64:
		return p == nil
	default:
		return v == nil
	}
}

func testSweeps(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	floor := -70.5
	sw := model.SpectrumSweep{
		SweepID: "S1", Band: "ism_915", State: model.SweepRunning,
		StartedAt: base, Class: "E", StartHz: 902_000_000, StopHz: 928_000_000, Steps: 14,
	}
	if err := s.PutSweep(ctx, sw); err != nil {
		t.Fatal(err)
	}

	// A running sweep has no measurement, and that is not the same as an empty
	// one: an empty trace charts as a flat, quiet band.
	if _, err := s.GetSweepBins(ctx, "S1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a running sweep should have no bins, got %v", err)
	}

	ended := base.Add(30 * time.Second)
	sw.State, sw.EndedAt, sw.NoiseFloorDBFS = model.SweepCompleted, &ended, &floor
	if err := s.PutSweep(ctx, sw); err != nil {
		t.Fatal(err)
	}
	bins := json.RawMessage(`{"band":"ism_915","steps":[{"bins_dbfs":[-70,-71]}]}`)
	if err := s.PutSweepBins(ctx, "S1", bins); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetSweep(ctx, "S1")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != model.SweepCompleted || got.EndedAt == nil {
		t.Fatalf("state not updated: %+v", got)
	}
	// A pointer float has to survive as a pointer. Flattened to 0 it reads as a
	// full-scale signal across the whole band.
	if got.NoiseFloorDBFS == nil || *got.NoiseFloorDBFS != floor {
		t.Fatalf("noise floor %v, want %v", got.NoiseFloorDBFS, floor)
	}
	if got.ThresholdDBFS != nil {
		t.Fatalf("threshold was never set but came back as %v", *got.ThresholdDBFS)
	}

	stored, err := s.GetSweepBins(ctx, "S1")
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != string(bins) {
		t.Fatalf("bins round trip: got %s want %s", stored, bins)
	}

	if _, err := s.GetSweep(ctx, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := s.PutSweepBins(ctx, "missing", bins); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("storing bins for a sweep that does not exist: %v", err)
	}

	// Newest first, and bounded.
	older := model.SpectrumSweep{
		SweepID: "S0", Band: "ism_433", State: model.SweepCompleted,
		StartedAt: base.Add(-time.Hour),
	}
	if err := s.PutSweep(ctx, older); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListSweeps(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].SweepID != "S1" {
		t.Fatalf("want newest first, got %+v", list)
	}
	if list, err = s.ListSweeps(ctx, 1); err != nil || len(list) != 1 || list[0].SweepID != "S1" {
		t.Fatalf("limit not applied: %+v %v", list, err)
	}

	// Retention takes the bins with the sweep -- they are the reason a sweep is
	// worth purging at all.
	n, err := s.PurgeSweeps(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged %d sweeps, want 1", n)
	}
	if _, err := s.GetSweep(ctx, "S0"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("purged sweep still readable: %v", err)
	}
	if _, err := s.GetSweep(ctx, "S1"); err != nil {
		t.Fatalf("the newer sweep was purged too: %v", err)
	}
}

func testUsers(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	if n, err := s.CountUsers(ctx); err != nil || n != 0 {
		t.Fatalf("a fresh store has %d users (%v)", n, err)
	}

	u := auth.User{
		UserID: "u1", Username: "admin", DisplayName: "Admin",
		Role: auth.RoleAdmin, PasswordHash: "$argon2id$fake",
		CreatedAt: base, UpdatedAt: base,
	}
	if err := s.PutUser(ctx, u); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetUser(ctx, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Username != "admin" || got.Role != auth.RoleAdmin || got.PasswordHash != u.PasswordHash {
		t.Fatalf("round trip: %+v", got)
	}
	if got.Disabled {
		t.Fatal("a user stored as enabled came back disabled")
	}
	// last_login_at is nullable and must stay nil rather than becoming the zero
	// time, which would render as the year 1.
	if got.LastLoginAt != nil {
		t.Fatalf("LastLoginAt is %v, want nil", got.LastLoginAt)
	}

	// Lookup normalises, so "Admin" finds the same row.
	for _, spelling := range []string{"admin", "Admin", " ADMIN "} {
		if _, err := s.GetUserByUsername(ctx, spelling); err != nil {
			t.Errorf("GetUserByUsername(%q): %v", spelling, err)
		}
	}
	if _, err := s.GetUserByUsername(ctx, "nobody"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	// An SSO-only account has no password. NULL must survive as empty rather
	// than becoming a hash that could be verified against.
	sso := auth.User{
		UserID: "u2", Username: "sso", Role: auth.RoleViewer,
		Issuer: "https://idp.example", Subject: "sub-1",
		CreatedAt: base, UpdatedAt: base,
	}
	if err := s.PutUser(ctx, sso); err != nil {
		t.Fatal(err)
	}
	back, err := s.GetUser(ctx, "u2")
	if err != nil {
		t.Fatal(err)
	}
	if back.HasPassword() {
		t.Fatal("an SSO account came back with a password")
	}

	found, err := s.GetUserByOIDC(ctx, "https://idp.example", "sub-1")
	if err != nil || found.UserID != "u2" {
		t.Fatalf("GetUserByOIDC: %+v %v", found, err)
	}
	// A local account must never be matched by an SSO lookup, or the first
	// login with a blank issuer would answer as an existing operator.
	if _, err := s.GetUserByOIDC(ctx, "", ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an empty issuer matched something: %v", err)
	}
	if _, err := s.GetUserByOIDC(ctx, "https://other", "sub-1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a subject matched under the wrong issuer: %v", err)
	}

	if n, err := s.CountAdmins(ctx); err != nil || n != 1 {
		t.Fatalf("CountAdmins = %d (%v), want 1", n, err)
	}
	// A disabled admin is not a usable one.
	u.Disabled = true
	if err := s.PutUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	if n, err := s.CountAdmins(ctx); err != nil || n != 0 {
		t.Fatalf("CountAdmins with the only admin disabled = %d (%v), want 0", n, err)
	}

	list, err := s.ListUsers(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("ListUsers: %d users (%v)", len(list), err)
	}
	if list[0].Username != "admin" || list[1].Username != "sso" {
		t.Fatalf("not sorted by username: %v", []string{list[0].Username, list[1].Username})
	}

	if err := s.DeleteUser(ctx, "u2"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(ctx, "u2"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleting twice: %v", err)
	}
}

func testSessions(t *testing.T, newStore Factory) {
	ctx := context.Background()
	s := newStore(t)

	if err := s.PutUser(ctx, auth.User{
		UserID: "u1", Username: "admin", Role: auth.RoleAdmin,
		CreatedAt: base, UpdatedAt: base,
	}); err != nil {
		t.Fatal(err)
	}

	sess := auth.Session{
		SessionID: "hash-of-token", UserID: "u1",
		CreatedAt: base, ExpiresAt: base.Add(time.Hour), LastSeen: base,
		UserAgent: "curl/8", IP: "10.0.0.5",
	}
	if err := s.PutSession(ctx, sess); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetSession(ctx, "hash-of-token")
	if err != nil {
		t.Fatal(err)
	}
	if got.UserID != "u1" || got.UserAgent != "curl/8" || got.IP != "10.0.0.5" {
		t.Fatalf("round trip: %+v", got)
	}
	if !got.ExpiresAt.Equal(base.Add(time.Hour)) {
		t.Fatalf("ExpiresAt %v", got.ExpiresAt)
	}

	later := base.Add(30 * time.Minute)
	if err := s.TouchSession(ctx, "hash-of-token", later, later.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetSession(ctx, "hash-of-token")
	if !got.LastSeen.Equal(later) || !got.ExpiresAt.Equal(later.Add(time.Hour)) {
		t.Fatalf("Touch did not slide the window: %+v", got)
	}

	if _, err := s.GetSession(ctx, "no-such-session"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	// Expired rows go; live ones stay.
	if err := s.PutSession(ctx, auth.Session{
		SessionID: "stale", UserID: "u1",
		CreatedAt: base.Add(-2 * time.Hour), ExpiresAt: base.Add(-time.Hour),
		LastSeen: base.Add(-2 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	n, err := s.PurgeExpiredSessions(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged %d, want 1", n)
	}
	if _, err := s.GetSession(ctx, "hash-of-token"); err != nil {
		t.Fatalf("the live session was purged: %v", err)
	}

	// Deleting a user takes their sessions. The SQL side gets this from
	// ON DELETE CASCADE; a map only gets it if someone remembered. A deleted
	// account whose cookie still works is the exact failure an admin thinks
	// they just prevented.
	if err := s.DeleteUser(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetSession(ctx, "hash-of-token"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a deleted user's session survived: %v", err)
	}
}

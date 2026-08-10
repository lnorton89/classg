package ingest

import (
	"context"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store/memstore"
)

func TestStaleTrackCloserArchivesOrphanedTrack(t *testing.T) {
	ctx := context.Background()
	st := memstore.New()
	now := time.Date(2026, 8, 10, 23, 0, 0, 0, time.UTC)
	for _, track := range []model.Track{
		{TrackID: "stale", State: "COASTING", FirstSeen: now.Add(-10 * time.Minute), LastSeen: now.Add(-6 * time.Minute)},
		{TrackID: "fresh", State: "CONFIRMED", FirstSeen: now.Add(-time.Minute), LastSeen: now.Add(-time.Minute)},
	} {
		if err := st.UpsertTrack(ctx, track); err != nil {
			t.Fatal(err)
		}
	}

	(&StaleTrackCloser{Store: st, TTL: 5 * time.Minute}).Sweep(ctx, now)

	stale, _ := st.GetTrack(ctx, "stale")
	fresh, _ := st.GetTrack(ctx, "fresh")
	if stale.State != "CLOSED" {
		t.Fatalf("stale state = %q, want CLOSED", stale.State)
	}
	if fresh.State != "CONFIRMED" {
		t.Fatalf("fresh state = %q, want CONFIRMED", fresh.State)
	}
}

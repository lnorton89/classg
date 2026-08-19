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

// A track stamped into the future -- a sensor clock running ahead, recorded
// before fusion clamped timestamps -- must not sit CONFIRMED forever. A future
// last_seen never gets past the ordinary cutoff, so the sweep closes anything
// more than a TTL ahead of now as a clock artifact.
func TestStaleTrackCloserArchivesFutureStampedTrack(t *testing.T) {
	ctx := context.Background()
	st := memstore.New()
	now := time.Date(2026, 8, 10, 23, 0, 0, 0, time.UTC)
	for _, track := range []model.Track{
		{TrackID: "phantom", State: "CONFIRMED", FirstSeen: now, LastSeen: now.Add(2 * time.Hour)},
		{TrackID: "slightly-ahead", State: "CONFIRMED", FirstSeen: now, LastSeen: now.Add(time.Minute)},
	} {
		if err := st.UpsertTrack(ctx, track); err != nil {
			t.Fatal(err)
		}
	}

	(&StaleTrackCloser{Store: st, TTL: 5 * time.Minute}).Sweep(ctx, now)

	phantom, _ := st.GetTrack(ctx, "phantom")
	if phantom.State != "CLOSED" {
		t.Fatalf("phantom state = %q, want CLOSED -- a future-stamped track would otherwise never close", phantom.State)
	}
	// Within a TTL of now is ordinary jitter, not an artifact.
	ahead, _ := st.GetTrack(ctx, "slightly-ahead")
	if ahead.State != "CONFIRMED" {
		t.Fatalf("slightly-ahead state = %q, want CONFIRMED", ahead.State)
	}
}

package ingest

import (
	"context"
	"log/slog"
	"time"

	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/store"
)

// StaleTrackCloser repairs the state left behind when fusion restarts before
// it can emit track.closed. Fusion remains the normal owner of track lifetime;
// this is the persistence-side safety net for already stored active tracks.
type StaleTrackCloser struct {
	Store    store.Store
	Hub      *hub.Hub
	TTL      time.Duration
	Interval time.Duration
}

func (c *StaleTrackCloser) Run(ctx context.Context) {
	if c.TTL <= 0 {
		return
	}
	interval := c.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	c.Sweep(ctx, time.Now().UTC())
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			c.Sweep(ctx, now.UTC())
		}
	}
}

// Sweep closes stored tracks whose last update is older than fusion's TTL.
func (c *StaleTrackCloser) Sweep(ctx context.Context, now time.Time) {
	if c.TTL <= 0 {
		return
	}
	page, err := c.Store.ListTracks(ctx, store.TrackQuery{
		States: []string{"TENTATIVE", "CONFIRMED", "COASTING"},
		Limit:  store.MaxLimit,
	})
	if err != nil {
		slog.Error("listing stale tracks failed", "err", err)
		return
	}
	cutoff := now.Add(-c.TTL)
	for _, candidate := range page.Tracks {
		if candidate.LastSeen.IsZero() || !candidate.LastSeen.Before(cutoff) {
			continue
		}
		// Re-read before writing so a concurrent fusion update cannot be
		// overwritten by the sweep's older snapshot.
		current, err := c.Store.GetTrack(ctx, candidate.TrackID)
		if err != nil || current.State == "CLOSED" || current.LastSeen.IsZero() ||
			!current.LastSeen.Before(cutoff) {
			continue
		}
		current.State = "CLOSED"
		if err := c.Store.UpsertTrack(ctx, current); err != nil {
			slog.Error("closing orphaned stale track failed", "track_id", current.TrackID, "err", err)
			continue
		}
		if c.Hub != nil {
			c.Hub.Broadcast(hub.Frame{Type: hub.TypeTrackClosed, TrackID: current.TrackID})
		}
		slog.Info("closed stale persisted track", "track_id", current.TrackID, "ttl", c.TTL)
	}
}

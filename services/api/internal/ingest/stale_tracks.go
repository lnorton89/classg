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
		// 30s against a TTL measured in minutes. The old 5s default ran the
		// sweep 60 times per TTL for no extra freshness -- this is a repair
		// job for fusion restarts, not a lifecycle owner.
		interval = 30 * time.Second
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

// Sweep closes stored tracks whose last update is older than fusion's TTL --
// and, symmetrically, tracks stamped more than a TTL into the FUTURE. fusion
// clamps sensor timestamps to its own clock now (fusion/track.go), but a doc
// written before that fix, or by anything else with a fast clock, would
// otherwise sit CONFIRMED on the map forever: a future last_seen never gets
// past the cutoff.
//
// Both bounds are decided in SQL on the indexed last_seen column. The sweep
// used to fetch and JSON-decode every open track once per tick just to
// compare timestamps in Go, which on the shared connection was most of its
// cost.
func (c *StaleTrackCloser) Sweep(ctx context.Context, now time.Time) {
	if c.TTL <= 0 {
		return
	}
	cutoff := now.Add(-c.TTL)
	c.closeMatching(ctx, store.TrackQuery{
		States:         []string{"TENTATIVE", "CONFIRMED", "COASTING"},
		LastSeenBefore: cutoff,
		SkipTotal:      true,
		Limit:          store.MaxLimit,
	}, func(lastSeen time.Time) bool {
		return !lastSeen.IsZero() && lastSeen.Before(cutoff)
	})

	horizon := now.Add(c.TTL)
	c.closeMatching(ctx, store.TrackQuery{
		States:    []string{"TENTATIVE", "CONFIRMED", "COASTING"},
		Since:     horizon, // Since is last_seen >= bound: only clock artifacts land here
		SkipTotal: true,
		Limit:     store.MaxLimit,
	}, func(lastSeen time.Time) bool {
		return !lastSeen.Before(horizon)
	})
}

// closeMatching archives every track the query returns, re-checking stillStale
// against a fresh read first: a concurrent fusion update must not be
// overwritten by the sweep's older snapshot.
func (c *StaleTrackCloser) closeMatching(ctx context.Context, q store.TrackQuery, stillStale func(lastSeen time.Time) bool) {
	page, err := c.Store.ListTracks(ctx, q)
	if err != nil {
		slog.Error("listing stale tracks failed", "err", err)
		return
	}
	for _, candidate := range page.Tracks {
		current, err := c.Store.GetTrack(ctx, candidate.TrackID)
		if err != nil || current.State == "CLOSED" || current.LastSeen.IsZero() ||
			!stillStale(current.LastSeen) {
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

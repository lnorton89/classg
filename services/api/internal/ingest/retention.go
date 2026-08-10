package ingest

import (
	"context"
	"log/slog"
	"time"

	"github.com/classg/api/internal/store"
)

// Retention deletes data past its retention window.
//
// One policy per data class, both configurable, both applied by the same job.
// The windows come from data-model.md#retention: detections are kept long
// enough to debug a parser against a real capture, tracks long enough to see a
// pattern.
type Retention struct {
	Store      store.Store
	Detections time.Duration
	Tracks     time.Duration
	Interval   time.Duration
}

func (r *Retention) Run(ctx context.Context) {
	interval := r.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	// Sweep once at startup: a Pi that was powered off for a week would
	// otherwise serve expired rows until the first tick.
	r.Sweep(ctx, time.Now().UTC())

	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			r.Sweep(ctx, now.UTC())
		}
	}
}

// Sweep is exported so tests can drive it without waiting for a ticker.
func (r *Retention) Sweep(ctx context.Context, now time.Time) {
	if r.Detections > 0 {
		if n, err := r.Store.PurgeDetections(ctx, now.Add(-r.Detections)); err != nil {
			slog.Error("purging detections failed", "err", err)
		} else if n > 0 {
			slog.Info("retention: purged detections", "rows", n, "older_than", r.Detections)
		}
	}
	if r.Tracks > 0 {
		if n, err := r.Store.PurgeTracks(ctx, now.Add(-r.Tracks)); err != nil {
			slog.Error("purging tracks failed", "err", err)
		} else if n > 0 {
			slog.Info("retention: purged tracks", "rows", n, "older_than", r.Tracks)
		}
	}
}

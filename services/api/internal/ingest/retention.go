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
	// Telemetry is kept longer than detections by default: a sample is a few
	// dozen bytes, and the questions it answers ("has free disk been sliding
	// for a week") need a week to answer.
	Telemetry time.Duration
	// Sweeps is shorter than everything else by default, and for the opposite
	// reason: one sweep of fpv_1g2 is 146 steps of 1024 bins, so a stored sweep
	// is about a megabyte -- three orders of magnitude bigger than a telemetry
	// sample. Unbounded, an operator who sweeps daily fills a Pi's card with
	// spectra nobody has looked at since.
	Sweeps time.Duration
	// Sessions is the auth service, if there is one. Expired sessions are
	// deleted on sight during Authenticate, so this only sweeps the ones
	// belonging to browsers that never came back.
	Sessions interface {
		PurgeSessions(ctx context.Context) (int64, error)
	}
	// HookDeliveries is the alert history. Kept for a month by default: it is
	// small, and "why did I not get an alert" is a question asked about last
	// week rather than last hour.
	HookDeliveries time.Duration
	Interval       time.Duration
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
	if r.Telemetry > 0 {
		if n, err := r.Store.PurgeTelemetry(ctx, now.Add(-r.Telemetry)); err != nil {
			slog.Error("purging telemetry failed", "err", err)
		} else if n > 0 {
			slog.Info("retention: purged telemetry", "rows", n, "older_than", r.Telemetry)
		}
	}
	if r.Sessions != nil {
		if n, err := r.Sessions.PurgeSessions(ctx); err != nil {
			slog.Error("purging expired sessions failed", "err", err)
		} else if n > 0 {
			slog.Info("retention: purged expired sessions", "rows", n)
		}
	}
	if r.HookDeliveries > 0 {
		if n, err := r.Store.PurgeHookDeliveries(ctx, now.Add(-r.HookDeliveries)); err != nil {
			slog.Error("purging hook deliveries failed", "err", err)
		} else if n > 0 {
			slog.Info("retention: purged hook deliveries", "rows", n, "older_than", r.HookDeliveries)
		}
	}
	if r.Sweeps > 0 {
		if n, err := r.Store.PurgeSweeps(ctx, now.Add(-r.Sweeps)); err != nil {
			slog.Error("purging sweeps failed", "err", err)
		} else if n > 0 {
			slog.Info("retention: purged spectrum sweeps", "rows", n, "older_than", r.Sweeps)
		}
	}
}

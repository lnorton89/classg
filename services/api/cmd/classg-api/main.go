// Command classg-api serves the ClassG REST and WebSocket API.
//
// It is designed to start and stay up when everything around it is broken.
// Sensors and fusion are separate processes that may not be running
// (ADR-0003), and the health endpoint can only report a broken pipeline if the
// api is alive to report it. The only startup failures are ones this process
// cannot work around: invalid configuration and an unopenable database.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/classg/api/internal/bus"
	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/httpapi"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/ingest"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/settings"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/libsqlstore"
	"github.com/classg/api/internal/store/memstore"
)

func main() {
	if err := run(); err != nil {
		// A configuration or startup failure is an operator's problem to fix,
		// so it prints as a message, never as a panic or a stack trace.
		fmt.Fprintln(os.Stderr, "classg-api: "+err.Error())
		os.Exit(1)
	}
}

func run() error {
	// ADR-0007 configuration tiers, in dependency order: Tier 1 from the
	// environment opens the store, the store supplies Tier 2, and the seed file
	// fills whatever the store has not been told.
	loaded, err := config.LoadDotEnv()
	if err != nil {
		return err
	}

	boot, err := config.BootstrapFromEnv()
	if err != nil {
		return err
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr,
		&slog.HandlerOptions{Level: logLevel(boot.LogLevel)})))
	if loaded != "" {
		slog.Info("loaded environment file", "path", loaded)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := openStore(ctx, boot)
	if err != nil {
		return err
	}
	defer st.Close()

	seed, err := settings.LoadSeed(boot.SeedPath)
	if err != nil {
		return err
	}
	if seeded, err := settings.SeedIfEmpty(ctx, st, seed); err != nil {
		return err
	} else if seeded {
		slog.Info("seeded settings from file", "path", boot.SeedPath, "count", len(seed))
	}
	stored, err := settings.LoadFromStore(ctx, st)
	if err != nil {
		return err
	}
	set, err := settings.Resolve(stored, seed, os.Getenv)
	if err != nil {
		return err
	}

	cfg, err := config.Assemble(boot, set)
	if err != nil {
		return err
	}

	// Environment overrides of database settings are legal but never silent:
	// the invisible-source problem is the whole reason ADR-0007 exists.
	var overridden []string
	for _, k := range set.Keys() {
		if set.Source(k) == settings.SourceEnv {
			overridden = append(overridden, k)
		}
	}
	if len(overridden) > 0 {
		slog.Warn("settings overridden by environment; stored values are ignored for these",
			"keys", strings.Join(overridden, ","))
	}

	registry := health.NewRegistry(cfg.SensorStaleAfter)
	for _, d := range cfg.ExpectedSensors {
		registry.Expect(d.SensorID, d.SensorKind)
	}
	// Sensors seen before this process started are still real sensors. Seeding
	// from storage means an api restart does not make a dead radio disappear
	// from /health and turn a broken detector back into a quiet sky.
	if known, err := st.ListSensors(ctx); err == nil {
		for _, rec := range known {
			registry.Restore(rec.SensorID, rec.SensorKind, rec.LastHeartbeat, rec.Reason)
		}
	}
	registry.SetFusionState(cfg.TrackEndpoint != "", false, "connecting")

	h := hub.New()

	captures := capture.NewManager(st, capture.Options{
		Dir:               cfg.CaptureDir,
		AllowUnprivileged: cfg.CaptureAllowUnprivileged,
		PythonBin:         cfg.PythonBin,
		SensorWifiDir:     cfg.SensorWifiDir,
		OnUpdate: func(c model.Capture) {
			cc := c
			h.Broadcast(hub.Frame{Type: hub.TypeCaptureStatus, Capture: &cc})
		},
	})

	// Captures recorded outside the API -- scripts/first-capture.sh, which the
	// Milestone 0 docs tell operators to use -- have no database record and were
	// invisible in the list. Adopt them so what the UI shows matches what is on
	// disk. Idempotent, so a failure here is logged rather than fatal.
	if n, err := captures.AdoptOrphans(ctx); err != nil {
		slog.Warn("could not adopt existing captures", "err", err)
	} else if n > 0 {
		slog.Info("adopted existing captures", "count", n)
	}

	srv := httpapi.New(httpapi.Options{
		Config:   cfg,
		Store:    st,
		Registry: registry,
		Hub:      h,
		Captures: captures,
		Settings: set,
		Sensors:  httpapi.SystemdSensors{Argv: cfg.SensorRestartCommand},
		Started:  time.Now(),
	})

	in := &ingest.Ingestor{
		Store:                  st,
		Registry:               registry,
		Hub:                    h,
		MaxHistory:             cfg.MaxHistory,
		ExposeOperatorLocation: cfg.ExposeOperatorLocation,
	}

	go bus.Run(ctx, bus.Options{
		Name:      "fusion",
		Endpoint:  cfg.TrackEndpoint,
		Topics:    []string{cfg.TrackTopic},
		OnMessage: func(m bus.Message) { in.Track(ctx, m.Topic, m.Body) },
		OnState: func(s bus.State) {
			registry.SetFusionState(cfg.TrackEndpoint != "", s.Connected, s.Reason)
		},
	})

	go bus.Run(ctx, bus.Options{
		Name:     "sensors",
		Endpoint: cfg.DetectionEndpoint,
		Topics:   []string{cfg.DetectionTopic, cfg.HeartbeatTopic},
		OnMessage: func(m bus.Message) {
			switch {
			case strings.HasPrefix(m.Topic, cfg.HeartbeatTopic):
				in.Heartbeat(ctx, m.Topic, m.Body)
			default:
				in.Detection(ctx, m.Topic, m.Body)
			}
		},
	})

	go (&ingest.HealthBroadcaster{Hub: h, Snapshot: srv.Health}).Run(ctx)
	go (&ingest.Retention{
		Store:      st,
		Detections: cfg.RetentionDetections,
		Tracks:     cfg.RetentionTracks,
		Interval:   cfg.RetentionInterval,
	}).Run(ctx)
	go (&ingest.StaleTrackCloser{
		Store: st,
		Hub:   h,
		TTL:   cfg.FusionTrackTTL,
	}).Run(ctx)

	httpServer := &http.Server{
		Addr:    cfg.Listen,
		Handler: srv,
		// No WriteTimeout: it would cut the WebSocket stream at a fixed age
		// regardless of activity. Per-write deadlines in the stream handler
		// bound slow consumers instead.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("classg-api listening",
			"addr", cfg.Listen, "version", cfg.Version,
			"expose_operator_location", cfg.ExposeOperatorLocation,
			"store", cfg.Store)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

func openStore(ctx context.Context, boot *config.Bootstrap) (store.Store, error) {
	if boot.Store == config.StoreMemory {
		slog.Warn("CLASSG_STORE=memory: nothing persists across a restart, " +
			"and settings come entirely from the seed file")
		return memstore.New(), nil
	}
	st, err := libsqlstore.Open(ctx, libsqlstore.Options{
		Path:         boot.DBPath,
		SyncURL:      boot.TursoURL,
		AuthToken:    boot.TursoAuthToken,
		SyncInterval: boot.TursoSyncInterval,
	})
	if err != nil {
		return nil, err
	}
	if st.Synced() {
		slog.Info("libSQL embedded replica: syncing to Turso", "interval", boot.TursoSyncInterval)
	} else {
		slog.Info("libSQL local database: no sync configured", "path", boot.DBPath)
	}
	return st, nil
}

func logLevel(level string) slog.Level {
	switch strings.ToLower(level) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

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
	loaded, err := config.LoadDotEnv()
	if err != nil {
		return err
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel()})))
	if loaded != "" {
		slog.Info("loaded environment file", "path", loaded)
	}

	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()

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

	srv := httpapi.New(httpapi.Options{
		Config:   cfg,
		Store:    st,
		Registry: registry,
		Hub:      h,
		Captures: captures,
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

func openStore(ctx context.Context, cfg *config.Config) (store.Store, error) {
	if cfg.Store == config.StoreMemory {
		slog.Warn("CLASSG_STORE=memory: nothing will be persisted across a restart")
		return memstore.New(), nil
	}
	st, err := libsqlstore.Open(ctx, libsqlstore.Options{
		Path:         cfg.DBPath,
		SyncURL:      cfg.TursoURL,
		AuthToken:    cfg.TursoAuthToken,
		SyncInterval: cfg.TursoSyncInterval,
	})
	if err != nil {
		return nil, err
	}
	if st.Synced() {
		slog.Info("libSQL embedded replica: syncing to Turso", "interval", cfg.TursoSyncInterval)
	} else {
		slog.Info("libSQL local database: no sync configured", "path", cfg.DBPath)
	}
	return st, nil
}

func logLevel() slog.Level {
	switch strings.ToLower(os.Getenv("CLASSG_LOG_LEVEL")) {
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

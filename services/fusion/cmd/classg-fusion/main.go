package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/classg/fusion"
	"github.com/go-zeromq/zmq4"
	"github.com/joho/godotenv"
)

type busMessage struct {
	topic string
	body  []byte
	err   error
}

func main() {
	if err := loadEnvironment(); err != nil {
		slog.Error("load environment", "err", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	detectionEndpoint := env("CLASSG_DETECTION_ENDPOINT", "tcp://127.0.0.1:5556")
	trackEndpoint := env("CLASSG_TRACK_ENDPOINT", "tcp://127.0.0.1:5557")
	detectionTopic := env("CLASSG_DETECTION_TOPIC", "detection.")
	heartbeatTopic := env("CLASSG_HEARTBEAT_TOPIC", "heartbeat.")
	trackTopic := env("CLASSG_TRACK_TOPIC", "track.")
	detectionSocketMode := env("CLASSG_FUSION_DETECTION_SOCKET_MODE", "dial")
	reapInterval := envDuration("CLASSG_FUSION_REAP_INTERVAL", time.Second)
	lifecycle := fusion.DefaultLifecycle()
	lifecycle.CoastAfter = envDuration("CLASSG_FUSION_SENSOR_STALE_AFTER", lifecycle.CoastAfter)
	lifecycle.CloseAfter = envDuration("CLASSG_FUSION_TRACK_TTL", lifecycle.CloseAfter)
	if lifecycle.CloseAfter <= lifecycle.CoastAfter {
		slog.Error("invalid fusion lifecycle", "track_ttl", lifecycle.CloseAfter, "sensor_stale_after", lifecycle.CoastAfter)
		os.Exit(2)
	}

	sub := zmq4.NewSub(ctx)
	defer sub.Close()
	var busErr error
	switch detectionSocketMode {
	case "dial":
		busErr = sub.Dial(detectionEndpoint)
	case "listen":
		busErr = sub.Listen(detectionEndpoint)
	default:
		slog.Error("invalid detection socket mode", "mode", detectionSocketMode)
		os.Exit(2)
	}
	if busErr != nil {
		slog.Error("open detection bus", "endpoint", detectionEndpoint, "mode", detectionSocketMode, "err", busErr)
		os.Exit(1)
	}
	if err := sub.SetOption(zmq4.OptionSubscribe, detectionTopic); err != nil {
		slog.Error("subscribe detection bus", "topic", detectionTopic, "err", err)
		os.Exit(1)
	}
	if err := sub.SetOption(zmq4.OptionSubscribe, heartbeatTopic); err != nil {
		slog.Error("subscribe heartbeat bus", "topic", heartbeatTopic, "err", err)
		os.Exit(1)
	}

	pub := zmq4.NewPub(ctx)
	defer pub.Close()
	if err := pub.Listen(trackEndpoint); err != nil {
		slog.Error("listen track bus", "endpoint", trackEndpoint, "err", err)
		os.Exit(1)
	}

	store := fusion.NewTrackStoreWithLifecycle(fusion.DefaultWeights(), fusion.NewTrackID, lifecycle)
	messages := make(chan busMessage)
	go receive(ctx, sub, messages, detectionSocketMode == "listen")
	ticker := time.NewTicker(reapInterval)
	defer ticker.Stop()

	slog.Info("fusion ready", "detections", detectionEndpoint, "detection_mode", detectionSocketMode, "tracks", trackEndpoint)
	for {
		select {
		case <-ctx.Done():
			slog.Info("fusion stopped")
			return
		case msg := <-messages:
			if msg.err != nil {
				if !errors.Is(msg.err, context.Canceled) && ctx.Err() == nil {
					slog.Error("detection bus disconnected", "err", msg.err)
					os.Exit(1)
				}
				return
			}
			// Fusion is also the ingress relay. The API subscribes to this same
			// internal endpoint for raw detections and sensor heartbeats.
			if err := pub.Send(zmq4.NewMsgFrom([]byte(msg.topic), msg.body)); err != nil {
				slog.Error("relay sensor message", "topic", msg.topic, "err", err)
			}
			if strings.HasPrefix(msg.topic, heartbeatTopic) {
				continue
			}
			d, err := fusion.ParseDetection(msg.body)
			if err != nil {
				slog.Warn("dropping malformed detection", "topic", msg.topic, "err", err)
				continue
			}
			track := store.Ingest(d, time.Now().UTC())
			if err := publish(pub, trackTopic+"update", track); err != nil {
				slog.Error("publish track", "track_id", track.TrackID, "err", err)
			}
		case now := <-ticker.C:
			for _, track := range store.Reap(now.UTC()) {
				if track.State == fusion.StateClosed {
					if err := publish(pub, trackTopic+"closed", map[string]string{"track_id": track.TrackID}); err != nil {
						slog.Error("publish closed track", "track_id", track.TrackID, "err", err)
					}
					continue
				}
				if err := publish(pub, trackTopic+"update", track); err != nil {
					slog.Error("publish track lifecycle", "track_id", track.TrackID, "err", err)
				}
			}
		}
	}
}

func receive(ctx context.Context, sub zmq4.Socket, out chan<- busMessage, keepListening bool) {
	for {
		msg, err := sub.Recv()
		if err != nil {
			if keepListening && ctx.Err() == nil {
				slog.Info("sensor publisher disconnected; ingress remains available")
				select {
				case <-time.After(100 * time.Millisecond):
					continue
				case <-ctx.Done():
					return
				}
			}
			select {
			case out <- busMessage{err: err}:
			case <-ctx.Done():
			}
			return
		}
		if len(msg.Frames) < 2 {
			continue
		}
		select {
		case out <- busMessage{topic: string(msg.Frames[0]), body: msg.Frames[1]}:
		case <-ctx.Done():
			return
		}
	}
}

func publish(pub zmq4.Socket, topic string, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return pub.Send(zmq4.NewMsgFrom([]byte(topic), body))
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	d, err := time.ParseDuration(value)
	if err != nil || d <= 0 {
		slog.Error("invalid duration", "key", key, "value", value)
		os.Exit(2)
	}
	return d
}

func loadEnvironment() error {
	if explicit := strings.TrimSpace(os.Getenv("CLASSG_ENV_FILE")); explicit != "" {
		return godotenv.Load(explicit)
	}
	dir, err := os.Getwd()
	if err != nil {
		return err
	}
	for {
		candidate := filepath.Join(dir, ".env")
		if _, err := os.Stat(candidate); err == nil {
			return godotenv.Load(candidate)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil
		}
		dir = parent
	}
}

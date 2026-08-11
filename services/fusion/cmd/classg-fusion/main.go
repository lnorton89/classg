package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
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
	contacts := fusion.NewContactStore()
	contacts.UseAircraftDB(loadAircraftDB())
	messages := make(chan busMessage)
	go receive(ctx, sub, messages, detectionSocketMode == "listen")
	startNetADSB(ctx, messages, detectionTopic, heartbeatTopic)
	terrain := startTerrain(ctx)
	if terrain != nil {
		store.UseTerrain(terrain)
	}
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
			// Manned traffic is airspace context, not a track. The API already
			// holds this detection from the relay above -- which is how it
			// reaches the map -- so fusion keeps it purely as correlation state.
			if d.DetectionClass == fusion.ClassADSB {
				contact, isNew := contacts.Observe(d)
				switch {
				case contact == nil:
					slog.Warn("dropping ADS-B detection with no ICAO address", "sensor_id", d.SensorID)
				case isNew:
					attrs := []any{"icao", contact.ICAO, "callsign", contact.Callsign, "contacts", contacts.Len()}
					if contact.Aircraft != nil {
						attrs = append(attrs,
							"registration", contact.Aircraft.Registration,
							"type", contact.Aircraft.TypeCode,
							"operator", contact.Aircraft.Operator)
					}
					slog.Info("adsb contact acquired", attrs...)
				}
				continue
			}
			track := store.Ingest(d, time.Now().UTC())
			if track == nil {
				slog.Warn("dropping detection with no usable identity",
					"sensor_id", d.SensorID, "detection_class", d.DetectionClass, "detection_id", d.DetectionID)
				continue
			}
			if err := publish(pub, trackTopic+"update", track); err != nil {
				slog.Error("publish track", "track_id", track.TrackID, "err", err)
			}
		case now := <-ticker.C:
			for _, icao := range contacts.Reap(now.UTC()) {
				slog.Info("adsb contact lost", "icao", icao, "contacts", contacts.Len())
			}
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

// loadAircraftDB reads the offline OpenSky aircraft database, or returns nil.
//
// A missing or broken file degrades rather than exits, unlike a bad ADS-B
// position: this only supplies names for aircraft that are already being
// tracked correctly, so losing it costs legibility and not correctness. Losing
// it silently is the part that would be unacceptable, so it is logged at WARN
// with the path that failed.
func loadAircraftDB() *fusion.AircraftDB {
	path := strings.TrimSpace(os.Getenv("CLASSG_FUSION_AIRCRAFT_DB"))
	if path == "" {
		return nil
	}
	db, err := fusion.LoadAircraftDB(path)
	if err != nil {
		slog.Warn("aircraft database unavailable; ADS-B contacts will show hex addresses only",
			"path", path, "err", err)
		return nil
	}
	slog.Info("aircraft database loaded", "path", path, "aircraft", db.Len())
	return db
}

// startTerrain launches the elevation lookup if one is configured, returning
// nil when it is off.
//
// Off by default like the ADS-B feed, and for the same reason -- but unlike
// that feed this one is worth turning on even with no uplink, because
// CLASSG_FUSION_TERRAIN_URL pointed at a local OpenTopoData with SRTM tiles
// gives identical answers with nothing leaving the unit.
func startTerrain(ctx context.Context) *fusion.Terrain {
	if !envBool("CLASSG_FUSION_TERRAIN", false) {
		return nil
	}
	cfg := fusion.TerrainConfig{
		BaseURL:      env("CLASSG_FUSION_TERRAIN_URL", fusion.TerrainDefaultBaseURL),
		Dataset:      env("CLASSG_FUSION_TERRAIN_DATASET", fusion.TerrainDefaultDataset),
		MinInterval:  envDuration("CLASSG_FUSION_TERRAIN_MIN_INTERVAL", fusion.TerrainDefaultMinInterval),
		GeoidOffsetM: envFloat("CLASSG_FUSION_TERRAIN_GEOID_OFFSET_M", 0),
	}
	terrain := fusion.NewTerrain(cfg)
	if cfg.GeoidOffsetM == 0 {
		// Not a warning about a missing feature -- a warning that the numbers
		// are wrong by a known, correctable amount. See Terrain.ElevationM.
		slog.Warn("terrain enabled with no geoid correction; derived AGL will be off by the local geoid undulation",
			"set", "CLASSG_FUSION_TERRAIN_GEOID_OFFSET_M")
	}
	slog.Info("terrain elevation enabled", "source", cfg.BaseURL, "dataset", cfg.Dataset)
	go terrain.Run(ctx)
	return terrain
}

// startNetADSB launches the network ADS-B feed if one is configured.
//
// It pushes onto the same channel the ZeroMQ subscriber does, so relaying,
// parsing and contact correlation all happen in exactly one place. A feed that
// took its own path to ContactStore would be a second implementation of the
// ingest rules, and the two would drift.
//
// Off unless CLASSG_FUSION_NET_ADSB=true. A misconfiguration here is fatal at
// startup rather than degraded at runtime: an operator who asked for airspace
// context and got a silent no-op would read an empty sky as a quiet one.
func startNetADSB(ctx context.Context, out chan<- busMessage, detectionTopic, heartbeatTopic string) {
	if !envBool("CLASSG_FUSION_NET_ADSB", false) {
		return
	}
	// The same key the API stores as map.receiver_position and the settings
	// page edits, in the same "lat,lon" form. Deliberately not a private
	// CLASSG_RECEIVER_LAT/LON pair: a unit has one position, and two ways to
	// state it is two ways to state it wrongly.
	lat, lon, err := receiverPosition()
	if err != nil {
		slog.Error("invalid receiver position", "key", "CLASSG_RECEIVER_POSITION", "err", err)
		os.Exit(2)
	}
	cfg := fusion.NetADSBConfig{
		BaseURL:  env("CLASSG_FUSION_NET_ADSB_URL", fusion.NetADSBDefaultBaseURL),
		Lat:      lat,
		Lon:      lon,
		RadiusNM: envInt("CLASSG_FUSION_NET_ADSB_RADIUS_NM", fusion.NetADSBDefaultRadiusNM),
		Interval: envDuration("CLASSG_FUSION_NET_ADSB_INTERVAL", fusion.NetADSBDefaultInterval),
		SensorID: env("CLASSG_FUSION_NET_ADSB_SENSOR_ID", fusion.NetADSBDefaultSensorID),
	}
	feed, err := fusion.NewNetADSBFeed(cfg)
	if err != nil {
		slog.Error("invalid network ADS-B configuration", "err", err)
		os.Exit(2)
	}

	send := func(topic string, body []byte) {
		select {
		case out <- busMessage{topic: topic, body: body}:
		case <-ctx.Done():
		}
	}
	// Heartbeat shape and topic match classg_wifi/bus.py, because the API's
	// ingestor makes no distinction -- which is the point. A feed that stops
	// answering degrades /health the same way a wedged adapter does.
	published, dropped := 0, 0
	emitStatus := func(s fusion.NetADSBStatus) {
		detail := map[string]any{
			"source":    cfg.BaseURL,
			"radius_nm": cfg.RadiusNM,
			"aircraft":  s.Aircraft,
		}
		if s.Total > s.Aircraft {
			// Ground traffic and stale fixes are filtered, so total > forwarded
			// is normal. Reporting both is what makes a truncation at
			// MaxAircraft visible instead of looking like a quiet sky.
			detail["reported"] = s.Total
		}
		if !s.Healthy {
			detail["error"] = s.LastError
			detail["consecutive_failures"] = s.Failures
			dropped++
		}
		published += s.Aircraft
		body, err := json.Marshal(map[string]any{
			"schema_version": "1.0",
			"ts":             time.Now().UTC().Format(time.RFC3339Nano),
			"sensor_id":      feed.SensorID(),
			"sensor_kind":    "net",
			"healthy":        s.Healthy,
			"published":      published,
			"dropped":        dropped,
			"detail":         detail,
		})
		if err != nil {
			slog.Error("encode network ADS-B heartbeat", "err", err)
			return
		}
		send(heartbeatTopic+"net", body)
	}

	slog.Info("network adsb feed enabled",
		"source", cfg.BaseURL, "sensor_id", feed.SensorID(),
		"radius_nm", cfg.RadiusNM, "interval", feed.Interval())

	go feed.Run(ctx,
		func(body []byte) { send(detectionTopic+fusion.ClassADSB, body) },
		emitStatus,
	)
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

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		slog.Error("invalid boolean", "key", key, "value", value)
		os.Exit(2)
	}
	return parsed
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		slog.Error("invalid integer", "key", key, "value", value)
		os.Exit(2)
	}
	return parsed
}

// receiverPosition parses CLASSG_RECEIVER_POSITION, the "lat,lon" form the API
// stores as map.receiver_position. An empty value returns 0,0, which the feed
// rejects with a message naming the variable -- unset and misconfigured are
// different problems and should not report the same way.
func receiverPosition() (lat, lon float64, err error) {
	raw := strings.TrimSpace(os.Getenv("CLASSG_RECEIVER_POSITION"))
	if raw == "" {
		return 0, 0, nil
	}
	latRaw, lonRaw, ok := strings.Cut(raw, ",")
	if !ok {
		return 0, 0, fmt.Errorf("%q is not lat,lon", raw)
	}
	if lat, err = strconv.ParseFloat(strings.TrimSpace(latRaw), 64); err != nil {
		return 0, 0, fmt.Errorf("latitude %q: %w", latRaw, err)
	}
	if lon, err = strconv.ParseFloat(strings.TrimSpace(lonRaw), 64); err != nil {
		return 0, 0, fmt.Errorf("longitude %q: %w", lonRaw, err)
	}
	return lat, lon, nil
}

func envFloat(key string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		slog.Error("invalid number", "key", key, "value", value)
		os.Exit(2)
	}
	return parsed
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

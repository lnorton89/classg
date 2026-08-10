// Package config loads and validates the api service's environment.
//
// Everything is CLASSG_-prefixed and validated at startup. A misconfigured
// detector that starts anyway is the failure mode this package exists to
// prevent: it would report a healthy-looking empty sky while pointed at the
// wrong bus endpoint.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// SensorDecl is an expected sensor from CLASSG_EXPECTED_SENSORS.
//
// Declaring sensors up front is what lets /health report a sensor that never
// started at all. Without it, a sensor that dies before its first heartbeat is
// simply absent from the list, and absent reads as "quiet sky" -- exactly the
// false confidence ADR-0003 is written against.
type SensorDecl struct {
	SensorID   string
	SensorKind string
}

// StoreKind selects the persistence backend.
const (
	StoreLibSQL = "libsql"
	StoreMemory = "memory"
)

type Config struct {
	Listen  string
	Version string

	Store  string
	DBPath string

	// Turso sync is optional. Empty TursoURL means a purely local libSQL file
	// and no network calls -- the default, and fully functional.
	TursoURL          string
	TursoAuthToken    string
	TursoSyncInterval time.Duration

	// Bus. Empty means "not configured": the service still starts and serves,
	// it just reports the link as down. See ADR-0003 -- degrade, never refuse.
	TrackEndpoint     string
	DetectionEndpoint string
	TrackTopic        string
	DetectionTopic    string
	HeartbeatTopic    string
	FusionTrackTTL    time.Duration

	// ExposeOperatorLocation gates the operator ground position on every
	// response. Defaults to true; set false to strip it.
	ExposeOperatorLocation bool

	UIDir      string
	CaptureDir string

	ExpectedSensors  []SensorDecl
	SensorStaleAfter time.Duration

	RetentionDetections time.Duration
	RetentionTracks     time.Duration
	RetentionInterval   time.Duration

	// Capture subprocess environment.
	SensorWifiDir            string
	PythonBin                string
	CaptureAllowUnprivileged bool
	WifiInterface            string
	WifiChannel              int
	CaptureDurationS         int
	CaptureLabel             string

	// SensorRestartCommand is a template argv; %s is replaced with the systemd
	// unit derived from the sensor kind (ADR-0003 names the units).
	SensorRestartCommand []string

	MaxHistory int
}

const (
	defaultListen = ":8081"
	// Three missed heartbeats at the sensor default of 10 s. Two would make a
	// single scheduling hiccup on a loaded Pi look like a dead radio.
	defaultStaleAfter = 30 * time.Second
)

// Load reads configuration from getenv (os.Getenv in production, a map in
// tests) and returns every validation problem at once. Returning only the first
// means an operator fixes one variable per restart.
func Load(getenv func(string) string) (*Config, error) {
	var problems []string
	bad := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}

	getBool := func(key string, def bool) bool {
		raw := strings.TrimSpace(getenv(key))
		if raw == "" {
			return def
		}
		v, err := strconv.ParseBool(raw)
		if err != nil {
			bad("%s: %q is not a boolean (use true or false)", key, raw)
			return def
		}
		return v
	}

	getDuration := func(key string, def time.Duration) time.Duration {
		raw := strings.TrimSpace(getenv(key))
		if raw == "" {
			return def
		}
		v, err := time.ParseDuration(raw)
		if err != nil {
			bad("%s: %q is not a duration (e.g. 30s, 24h)", key, raw)
			return def
		}
		if v <= 0 {
			bad("%s: must be positive, got %s", key, v)
			return def
		}
		return v
	}

	getInt := func(key string, def int) int {
		raw := strings.TrimSpace(getenv(key))
		if raw == "" {
			return def
		}
		v, err := strconv.Atoi(raw)
		if err != nil {
			bad("%s: %q is not an integer", key, raw)
			return def
		}
		return v
	}

	cfg := &Config{
		Listen:  get("CLASSG_LISTEN", defaultListen),
		Version: get("CLASSG_VERSION", "0.1.0"),

		Store:  strings.ToLower(get("CLASSG_STORE", StoreLibSQL)),
		DBPath: get("CLASSG_DB", "classg.db"),

		TursoURL:          get("CLASSG_TURSO_URL", ""),
		TursoAuthToken:    get("CLASSG_TURSO_AUTH_TOKEN", ""),
		TursoSyncInterval: getDuration("CLASSG_TURSO_SYNC_INTERVAL", time.Minute),

		TrackEndpoint:     endpointOrOff(get("CLASSG_TRACK_ENDPOINT", "tcp://127.0.0.1:5557")),
		DetectionEndpoint: endpointOrOff(get("CLASSG_DETECTION_ENDPOINT", "tcp://127.0.0.1:5556")),
		TrackTopic:        get("CLASSG_TRACK_TOPIC", "track."),
		DetectionTopic:    get("CLASSG_DETECTION_TOPIC", "detection."),
		HeartbeatTopic:    get("CLASSG_HEARTBEAT_TOPIC", "heartbeat."),
		FusionTrackTTL:    getDuration("CLASSG_FUSION_TRACK_TTL", 5*time.Minute),

		ExposeOperatorLocation: getBool("CLASSG_EXPOSE_OPERATOR_LOCATION", true),

		UIDir:      get("CLASSG_UI_DIR", filepath.Join("..", "ui", "dist")),
		CaptureDir: get("CLASSG_CAPTURE_DIR", "captures"),

		SensorStaleAfter: getDuration("CLASSG_SENSOR_STALE_AFTER", defaultStaleAfter),

		RetentionDetections: getDuration("CLASSG_RETENTION_DETECTIONS", 7*24*time.Hour),
		RetentionTracks:     getDuration("CLASSG_RETENTION_TRACKS", 90*24*time.Hour),
		RetentionInterval:   getDuration("CLASSG_RETENTION_INTERVAL", time.Hour),

		SensorWifiDir:            get("CLASSG_SENSOR_WIFI_DIR", filepath.Join("..", "sensor-wifi")),
		PythonBin:                get("CLASSG_PYTHON", "python3"),
		CaptureAllowUnprivileged: getBool("CLASSG_CAPTURE_ALLOW_UNPRIVILEGED", false),
		WifiInterface:            get("CLASSG_WIFI_INTERFACE", "wlan1"),
		WifiChannel:              getInt("CLASSG_WIFI_CHANNEL", 6),
		CaptureDurationS:         getInt("CLASSG_CAPTURE_DURATION_S", 120),
		CaptureLabel:             get("CLASSG_CAPTURE_LABEL", "sensor-capture"),

		MaxHistory: getInt("CLASSG_MAX_HISTORY", 512),
	}

	if _, _, err := splitHostPort(cfg.Listen); err != nil {
		bad("CLASSG_LISTEN: %v", err)
	}
	switch cfg.Store {
	case StoreLibSQL:
		if cfg.DBPath == "" {
			bad("CLASSG_DB: must not be empty")
		}
	case StoreMemory:
		// Nothing persists. Allowed so the service can be run on an
		// unsupported platform for development; never for a deployment.
	default:
		bad("CLASSG_STORE: %q is not a known store (use %s or %s)", cfg.Store, StoreLibSQL, StoreMemory)
	}

	if cfg.TursoAuthToken != "" && cfg.TursoURL == "" {
		bad("CLASSG_TURSO_AUTH_TOKEN is set but CLASSG_TURSO_URL is not; " +
			"sync needs both, and with neither the service runs fully local")
	}
	if cfg.TursoURL != "" {
		if u, err := url.Parse(cfg.TursoURL); err != nil {
			bad("CLASSG_TURSO_URL: %q is not a valid URL", cfg.TursoURL)
		} else if u.Scheme != "libsql" && u.Scheme != "https" && u.Scheme != "http" {
			bad("CLASSG_TURSO_URL: scheme must be libsql, https or http (got %q)", u.Scheme)
		}
	}

	if cfg.MaxHistory < 1 {
		bad("CLASSG_MAX_HISTORY: must be >= 1, got %d", cfg.MaxHistory)
	}
	if cfg.WifiInterface == "" || len(cfg.WifiInterface) > 15 {
		bad("CLASSG_WIFI_INTERFACE: must be a Linux interface name of 1-15 characters")
	}
	if cfg.WifiChannel < 1 || cfg.WifiChannel > 165 {
		bad("CLASSG_WIFI_CHANNEL: must be between 1 and 165, got %d", cfg.WifiChannel)
	}
	if cfg.CaptureDurationS < 1 || cfg.CaptureDurationS > 3600 {
		bad("CLASSG_CAPTURE_DURATION_S: must be between 1 and 3600, got %d", cfg.CaptureDurationS)
	}

	for _, e := range []struct{ key, val string }{
		{"CLASSG_TRACK_ENDPOINT", cfg.TrackEndpoint},
		{"CLASSG_DETECTION_ENDPOINT", cfg.DetectionEndpoint},
	} {
		if e.val == "" {
			continue // explicitly disabled
		}
		if err := validateZMQEndpoint(e.val); err != nil {
			bad("%s: %v", e.key, err)
		}
	}

	decls, declErrs := parseSensorDecls(get("CLASSG_EXPECTED_SENSORS", ""))
	cfg.ExpectedSensors = decls
	for _, e := range declErrs {
		bad("CLASSG_EXPECTED_SENSORS: %s", e)
	}

	restart := get("CLASSG_SENSOR_RESTART_COMMAND", "systemctl restart %s")
	cfg.SensorRestartCommand = strings.Fields(restart)
	if len(cfg.SensorRestartCommand) == 0 {
		bad("CLASSG_SENSOR_RESTART_COMMAND: must not be empty")
	} else if !strings.Contains(restart, "%s") {
		bad("CLASSG_SENSOR_RESTART_COMMAND: must contain %%s, the systemd unit placeholder")
	}

	if len(problems) > 0 {
		return nil, &ValidationError{Problems: problems}
	}
	return cfg, nil
}

// ValidationError renders as an operator-readable list. main prints this and
// exits; it must never surface as a panic or a stack trace.
type ValidationError struct {
	Problems []string
}

func (e *ValidationError) Error() string {
	var b strings.Builder
	b.WriteString("invalid configuration:")
	for _, p := range e.Problems {
		b.WriteString("\n  - ")
		b.WriteString(p)
	}
	return b.String()
}

// endpointOrOff normalises the several ways an operator might try to say
// "there is no bus here" into the empty string.
func endpointOrOff(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "off", "none", "disabled":
		return ""
	}
	return v
}

func validateZMQEndpoint(v string) error {
	u, err := url.Parse(v)
	if err != nil {
		return fmt.Errorf("%q is not a valid endpoint URL", v)
	}
	switch u.Scheme {
	case "tcp", "ipc", "inproc":
	default:
		return fmt.Errorf("%q: scheme must be tcp, ipc or inproc (got %q)", v, u.Scheme)
	}
	if u.Scheme == "tcp" && u.Host == "" {
		return fmt.Errorf("%q: tcp endpoint needs host:port", v)
	}
	return nil
}

func splitHostPort(addr string) (string, string, error) {
	i := strings.LastIndex(addr, ":")
	if i < 0 {
		return "", "", errors.New("must be host:port or :port")
	}
	port := addr[i+1:]
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", "", fmt.Errorf("%q is not a valid port", port)
	}
	return addr[:i], port, nil
}

// parseSensorDecls reads "wifi-0:wifi,sdr-0:sdr".
func parseSensorDecls(raw string) ([]SensorDecl, []string) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var (
		out  []SensorDecl
		errs []string
		seen = map[string]bool{}
	)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, kind, ok := strings.Cut(part, ":")
		id, kind = strings.TrimSpace(id), strings.TrimSpace(kind)
		if !ok || id == "" || kind == "" {
			errs = append(errs, fmt.Sprintf("%q is not sensor_id:sensor_kind", part))
			continue
		}
		switch kind {
		case "wifi", "sdr", "ble":
		default:
			errs = append(errs, fmt.Sprintf("%q: sensor_kind must be wifi, sdr or ble", part))
			continue
		}
		if seen[id] {
			errs = append(errs, fmt.Sprintf("%q: duplicate sensor_id", id))
			continue
		}
		seen[id] = true
		out = append(out, SensorDecl{SensorID: id, SensorKind: kind})
	}
	return out, errs
}

// FromEnv is the production entry point.
func FromEnv() (*Config, error) { return Load(os.Getenv) }

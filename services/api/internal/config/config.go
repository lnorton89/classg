// Package config implements Tier 1 of ADR-0007 and assembles the effective
// configuration from all three tiers.
//
// Tier 1 (this file, environment only) is the short list needed to find and
// open the store, plus secrets. Everything else is Tier 2 and lives in the
// database, seeded from config/defaults.yaml -- see internal/settings.
//
// A misconfigured detector that starts anyway is the failure mode this package
// exists to prevent: it would report a healthy-looking empty sky while pointed
// at the wrong bus endpoint.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/classg/api/internal/settings"
)

// SensorDecl is an expected sensor.
//
// Declaring sensors up front is what lets /health report a sensor that never
// started at all. Without it, a sensor that dies before its first heartbeat is
// simply absent from the list, and absent reads as "quiet sky" -- exactly the
// false confidence ADR-0003 is written against.
type SensorDecl = settings.SensorDecl

// StoreKind selects the persistence backend.
const (
	StoreLibSQL = "libsql"
	StoreMemory = "memory"
)

const (
	defaultListen = ":8081"
	// Path is relative to services/api, where the binary is run from in dev.
	defaultSeedPath = settings.DefaultSeedPath
)

// Bootstrap is Tier 1: environment only, and the only place secrets live.
//
// These cannot come from the database because they are what makes the database
// reachable in the first place.
type Bootstrap struct {
	Listen   string
	LogLevel string
	SeedPath string

	Store  string
	DBPath string

	// Turso sync is optional. Empty TursoURL means a purely local libSQL file
	// and no network calls -- the default, and fully functional.
	TursoURL          string
	TursoAuthToken    string
	TursoSyncInterval time.Duration

	// Authentication. Tier 1 because the OIDC client secret is a secret, and
	// because a box whose auth mode is editable through its own web UI can be
	// switched off by whoever already got in.
	AuthMode   string
	SessionTTL time.Duration

	// SMTP. Tier 1 because the password is a secret: in the settings table it
	// would be readable by anything that can read /config/settings.
	SMTPHost        string
	SMTPPort        int
	SMTPUser        string
	SMTPPassword    string
	SMTPFrom        string
	SMTPStartTLS    bool
	SMTPImplicit    bool
	OIDCIssuer      string
	OIDCClientID    string
	OIDCSecret      string
	OIDCRedirectURL string
	OIDCLabel       string
	// OIDCAutoProvision creates an account on first successful SSO login. Off
	// by default: a provider that issues tokens to anyone with a Google account
	// would otherwise make "SSO configured" mean "anyone is an operator".
	OIDCAutoProvision bool
	OIDCRole          string
	OIDCUsernameClaim string
}

// Config is the effective configuration, assembled from all tiers. Downstream
// code reads this and does not care which tier a value came from; GET
// /config/settings is where the source is reported.
type Config struct {
	Listen  string
	Version string

	Store  string
	DBPath string

	TursoURL          string
	TursoAuthToken    string
	TursoSyncInterval time.Duration

	AuthMode          string
	SessionTTL        time.Duration
	SMTPHost          string
	SMTPPort          int
	SMTPUser          string
	SMTPPassword      string
	SMTPFrom          string
	SMTPStartTLS      bool
	SMTPImplicit      bool
	OIDCIssuer        string
	OIDCClientID      string
	OIDCSecret        string
	OIDCRedirectURL   string
	OIDCLabel         string
	OIDCAutoProvision bool
	OIDCRole          string
	OIDCUsernameClaim string

	// Bus. Empty means "not configured": the service still starts and serves,
	// it just reports the link as down. See ADR-0003 -- degrade, never refuse.
	TrackEndpoint     string
	DetectionEndpoint string
	TrackTopic        string
	DetectionTopic    string
	HeartbeatTopic    string
	FusionTrackTTL    time.Duration

	ExposeOperatorLocation bool

	UIDir      string
	CaptureDir string

	ExpectedSensors  []SensorDecl
	SensorStaleAfter time.Duration

	RetentionDetections     time.Duration
	RetentionTracks         time.Duration
	RetentionTelemetry      time.Duration
	RetentionSweeps         time.Duration
	RetentionHookDeliveries time.Duration
	HooksAllowPrivate       bool
	TelemetryInterval       time.Duration
	RetentionInterval       time.Duration

	SensorWifiDir            string
	PythonBin                string
	SDRBin                   string
	SweepTimeout             time.Duration
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

// LoadBootstrap reads Tier 1 and returns every validation problem at once.
// Returning only the first means an operator fixes one variable per restart.
// boolEnv reads a boolean with a default, tolerating the spellings people
// actually write in a .env file.
func boolEnv(getenv func(string) string, key string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(getenv(key))) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		return def
	}
}

func LoadBootstrap(getenv func(string) string) (*Bootstrap, error) {
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

	b := &Bootstrap{
		Listen:   get("CLASSG_LISTEN", defaultListen),
		LogLevel: strings.ToLower(get("CLASSG_LOG_LEVEL", "info")),
		SeedPath: get("CLASSG_CONFIG_SEED", defaultSeedPath),

		Store:  strings.ToLower(get("CLASSG_STORE", StoreLibSQL)),
		DBPath: get("CLASSG_DB", "classg.db"),

		TursoURL:       get("CLASSG_TURSO_URL", ""),
		TursoAuthToken: get("CLASSG_TURSO_AUTH_TOKEN", ""),

		AuthMode:          strings.ToLower(get("CLASSG_AUTH_MODE", "required")),
		SMTPHost:          get("CLASSG_SMTP_HOST", ""),
		SMTPUser:          get("CLASSG_SMTP_USERNAME", ""),
		SMTPPassword:      get("CLASSG_SMTP_PASSWORD", ""),
		SMTPFrom:          get("CLASSG_SMTP_FROM", ""),
		OIDCIssuer:        get("CLASSG_OIDC_ISSUER", ""),
		OIDCClientID:      get("CLASSG_OIDC_CLIENT_ID", ""),
		OIDCSecret:        get("CLASSG_OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURL:   get("CLASSG_OIDC_REDIRECT_URL", ""),
		OIDCLabel:         get("CLASSG_OIDC_LABEL", ""),
		OIDCRole:          strings.ToLower(get("CLASSG_OIDC_ROLE", "viewer")),
		OIDCUsernameClaim: get("CLASSG_OIDC_USERNAME_CLAIM", ""),
	}

	raw := strings.TrimSpace(getenv("CLASSG_TURSO_SYNC_INTERVAL"))
	b.TursoSyncInterval = time.Minute
	if raw != "" {
		v, err := time.ParseDuration(raw)
		switch {
		case err != nil:
			bad("CLASSG_TURSO_SYNC_INTERVAL: %q is not a duration (e.g. 30s, 1m)", raw)
		case v <= 0:
			bad("CLASSG_TURSO_SYNC_INTERVAL: must be positive, got %s", v)
		default:
			b.TursoSyncInterval = v
		}
	}

	rawTTL := strings.TrimSpace(getenv("CLASSG_SESSION_TTL"))
	b.SessionTTL = 12 * time.Hour
	if rawTTL != "" {
		v, err := time.ParseDuration(rawTTL)
		switch {
		case err != nil:
			bad("CLASSG_SESSION_TTL: %q is not a duration (e.g. 12h, 30m)", rawTTL)
		case v <= 0:
			bad("CLASSG_SESSION_TTL: must be positive, got %s", v)
		default:
			b.SessionTTL = v
		}
	}

	if raw := strings.TrimSpace(getenv("CLASSG_SMTP_PORT")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > 65535 {
			bad("CLASSG_SMTP_PORT: %q is not a port", raw)
		} else {
			b.SMTPPort = v
		}
	}
	b.SMTPStartTLS = boolEnv(getenv, "CLASSG_SMTP_STARTTLS", true)
	b.SMTPImplicit = boolEnv(getenv, "CLASSG_SMTP_TLS", false)
	if b.SMTPHost != "" && b.SMTPFrom == "" {
		bad("CLASSG_SMTP_FROM is required when CLASSG_SMTP_HOST is set; " +
			"a mail server needs an envelope sender it will accept")
	}

	switch b.AuthMode {
	case "required", "off":
	default:
		bad("CLASSG_AUTH_MODE: %q is not a mode (use required or off)", b.AuthMode)
	}
	rawAuto := strings.ToLower(strings.TrimSpace(getenv("CLASSG_OIDC_AUTO_PROVISION")))
	switch rawAuto {
	case "", "false", "0", "no":
		b.OIDCAutoProvision = false
	case "true", "1", "yes":
		b.OIDCAutoProvision = true
	default:
		bad("CLASSG_OIDC_AUTO_PROVISION: %q is not a boolean", rawAuto)
	}

	// Every OIDC field or none. A half-configured provider fails at the first
	// login attempt, which is the worst moment to discover it.
	oidcSet := 0
	for _, v := range []string{b.OIDCIssuer, b.OIDCClientID, b.OIDCSecret, b.OIDCRedirectURL} {
		if v != "" {
			oidcSet++
		}
	}
	if oidcSet != 0 && oidcSet != 4 {
		bad("single sign-on needs CLASSG_OIDC_ISSUER, CLASSG_OIDC_CLIENT_ID, " +
			"CLASSG_OIDC_CLIENT_SECRET and CLASSG_OIDC_REDIRECT_URL together, or none of them")
	}
	if b.OIDCRole == "admin" {
		bad("CLASSG_OIDC_ROLE: refusing to auto-provision administrators; " +
			"whoever controls the identity provider would control this unit")
	}
	if b.OIDCRole != "" && b.OIDCRole != "viewer" && b.OIDCRole != "operator" {
		bad("CLASSG_OIDC_ROLE: %q is not a role (use viewer or operator)", b.OIDCRole)
	}

	if _, _, err := splitHostPort(b.Listen); err != nil {
		bad("CLASSG_LISTEN: %v", err)
	}

	switch b.Store {
	case StoreLibSQL:
		if b.DBPath == "" {
			bad("CLASSG_DB: must not be empty")
		}
	case StoreMemory:
		// Nothing persists. Configuration comes entirely from the seed file,
		// which is what makes memory mode coherent rather than a degraded
		// special case (ADR-0007).
	default:
		bad("CLASSG_STORE: %q is not a known store (use %s or %s)", b.Store, StoreLibSQL, StoreMemory)
	}

	if b.TursoAuthToken != "" && b.TursoURL == "" {
		bad("CLASSG_TURSO_AUTH_TOKEN is set but CLASSG_TURSO_URL is not; " +
			"sync needs both, and with neither the service runs fully local")
	}
	if b.TursoURL != "" {
		if u, err := url.Parse(b.TursoURL); err != nil {
			bad("CLASSG_TURSO_URL: %q is not a valid URL", b.TursoURL)
		} else if u.Scheme != "libsql" && u.Scheme != "https" && u.Scheme != "http" {
			bad("CLASSG_TURSO_URL: scheme must be libsql, https or http (got %q)", u.Scheme)
		}
	}

	if len(problems) > 0 {
		return nil, &ValidationError{Problems: problems}
	}
	return b, nil
}

// Assemble builds the effective configuration from Tier 1 and Tier 2.
//
// Settings have already been type-checked by settings.Resolve; what remains
// here is the cross-field semantics that only mean something once assembled,
// like whether a bus endpoint is a usable ZMQ address.
func Assemble(b *Bootstrap, s *settings.Settings) (*Config, error) {
	var problems []string
	bad := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	cfg := &Config{
		Listen:  b.Listen,
		Version: s.String("api.version"),

		Store:             b.Store,
		DBPath:            b.DBPath,
		TursoURL:          b.TursoURL,
		TursoAuthToken:    b.TursoAuthToken,
		AuthMode:          b.AuthMode,
		SMTPHost:          b.SMTPHost,
		SMTPPort:          b.SMTPPort,
		SMTPUser:          b.SMTPUser,
		SMTPPassword:      b.SMTPPassword,
		SMTPFrom:          b.SMTPFrom,
		SMTPStartTLS:      b.SMTPStartTLS,
		SMTPImplicit:      b.SMTPImplicit,
		SessionTTL:        b.SessionTTL,
		OIDCIssuer:        b.OIDCIssuer,
		OIDCClientID:      b.OIDCClientID,
		OIDCSecret:        b.OIDCSecret,
		OIDCRedirectURL:   b.OIDCRedirectURL,
		OIDCLabel:         b.OIDCLabel,
		OIDCAutoProvision: b.OIDCAutoProvision,
		OIDCRole:          b.OIDCRole,
		OIDCUsernameClaim: b.OIDCUsernameClaim,
		TursoSyncInterval: b.TursoSyncInterval,

		TrackEndpoint:     endpointOrOff(s.String("bus.track_endpoint")),
		DetectionEndpoint: endpointOrOff(s.String("bus.detection_endpoint")),
		TrackTopic:        s.String("bus.track_topic"),
		DetectionTopic:    s.String("bus.detection_topic"),
		HeartbeatTopic:    s.String("bus.heartbeat_topic"),
		FusionTrackTTL:    s.Duration("fusion.track_ttl"),

		ExposeOperatorLocation: s.Bool("api.expose_operator_location"),

		UIDir:      s.String("api.ui_dir"),
		CaptureDir: s.String("capture.dir"),

		ExpectedSensors:  s.SensorDecls("sensors.expected"),
		SensorStaleAfter: s.Duration("sensors.stale_after"),

		RetentionDetections:     s.Duration("retention.detections"),
		RetentionTracks:         s.Duration("retention.tracks"),
		RetentionTelemetry:      s.Duration("retention.telemetry"),
		RetentionSweeps:         s.Duration("retention.sweeps"),
		RetentionHookDeliveries: s.Duration("retention.hook_deliveries"),
		HooksAllowPrivate:       s.Bool("hooks.allow_private_targets"),
		TelemetryInterval:       s.Duration("telemetry.interval"),
		RetentionInterval:       s.Duration("retention.interval"),

		SensorWifiDir:            s.String("capture.sensor_wifi_dir"),
		PythonBin:                s.String("capture.python_bin"),
		SDRBin:                   s.String("spectrum.sdr_bin"),
		SweepTimeout:             s.Duration("spectrum.sweep_timeout"),
		CaptureAllowUnprivileged: s.Bool("capture.allow_unprivileged"),
		WifiInterface:            s.String("capture.wifi_interface"),
		WifiChannel:              s.Int("capture.wifi_channel"),
		CaptureDurationS:         s.Int("capture.duration_s"),
		CaptureLabel:             s.String("capture.label"),

		MaxHistory: s.Int("fusion.max_history"),
	}

	for _, e := range []struct{ key, val string }{
		{"bus.track_endpoint", cfg.TrackEndpoint},
		{"bus.detection_endpoint", cfg.DetectionEndpoint},
	} {
		if e.val == "" {
			continue // explicitly disabled
		}
		if err := validateZMQEndpoint(e.val); err != nil {
			bad("%s: %v", e.key, err)
		}
	}

	if cfg.MaxHistory < 1 {
		bad("fusion.max_history: must be >= 1, got %d", cfg.MaxHistory)
	}
	if cfg.WifiInterface == "" || len(cfg.WifiInterface) > 15 {
		bad("capture.wifi_interface: must be a Linux interface name of 1-15 characters")
	}
	if cfg.WifiChannel < 1 || cfg.WifiChannel > 165 {
		bad("capture.wifi_channel: must be between 1 and 165, got %d", cfg.WifiChannel)
	}
	if cfg.CaptureDurationS < 1 || cfg.CaptureDurationS > 3600 {
		bad("capture.duration_s: must be between 1 and 3600, got %d", cfg.CaptureDurationS)
	}

	restart := s.String("sensors.restart_command")
	cfg.SensorRestartCommand = strings.Fields(restart)
	switch {
	case len(cfg.SensorRestartCommand) == 0:
		bad("sensors.restart_command: must not be empty")
	case !strings.Contains(restart, "%s"):
		bad("sensors.restart_command: must contain %%s, the systemd unit placeholder")
	}

	if len(problems) > 0 {
		return nil, &ValidationError{Problems: problems}
	}
	return cfg, nil
}

// MaxHistory is Tier 2 but read separately by the ingestor.
func MaxHistory(s *settings.Settings) int { return s.Int("fusion.max_history") }

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

// BootstrapFromEnv is the production entry point for Tier 1.
func BootstrapFromEnv() (*Bootstrap, error) { return LoadBootstrap(os.Getenv) }

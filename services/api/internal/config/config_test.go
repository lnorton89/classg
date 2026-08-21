package config

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/settings"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func noEnv(string) string { return "" }

// resolve builds Tier 2 from raw stored values, as main does at startup.
func resolve(t *testing.T, db map[string]string, getenv func(string) string) *settings.Settings {
	t.Helper()
	s, err := settings.Resolve(db, nil, getenv)
	if err != nil {
		t.Fatalf("settings did not resolve: %v", err)
	}
	return s
}

func assemble(t *testing.T, boot map[string]string, db map[string]string) (*Config, error) {
	t.Helper()
	b, err := LoadBootstrap(env(boot))
	if err != nil {
		return nil, err
	}
	return Assemble(b, resolve(t, db, noEnv))
}

// --- Tier 1 -----------------------------------------------------------------

func TestBootstrapDefaults(t *testing.T) {
	b, err := LoadBootstrap(noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if b.Listen != defaultListen {
		t.Fatalf("Listen = %q", b.Listen)
	}
	// Persistence is the default. A committed .env.example once shipped
	// memory, which disagreed with both this and Compose -- the exact bug
	// ADR-0007 was written against.
	if b.Store != StoreLibSQL {
		t.Fatalf("Store = %q, want %q", b.Store, StoreLibSQL)
	}
	if b.SeedPath == "" {
		t.Fatal("SeedPath must have a default")
	}
}

func TestNoTursoCredentialsIsTheDefaultPath(t *testing.T) {
	b, err := LoadBootstrap(noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if b.TursoURL != "" || b.TursoAuthToken != "" {
		t.Fatal("a fresh install must be fully local with no network calls")
	}
}

func TestBootstrapValidation(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"bad listen", map[string]string{"CLASSG_LISTEN": "nope"}, "CLASSG_LISTEN"},
		{"bad port", map[string]string{"CLASSG_LISTEN": ":99999"}, "CLASSG_LISTEN"},
		{"unknown store", map[string]string{"CLASSG_STORE": "postgres"}, "CLASSG_STORE"},
		{"empty db path", map[string]string{"CLASSG_DB": " "}, ""},
		{
			"token without url",
			map[string]string{"CLASSG_TURSO_AUTH_TOKEN": "secret"},
			"CLASSG_TURSO_AUTH_TOKEN",
		},
		{
			"bad turso scheme",
			map[string]string{"CLASSG_TURSO_URL": "ftp://example.com"},
			"CLASSG_TURSO_URL",
		},
		{
			"bad sync interval",
			map[string]string{"CLASSG_TURSO_SYNC_INTERVAL": "soon"},
			"CLASSG_TURSO_SYNC_INTERVAL",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadBootstrap(env(tc.env))
			if tc.want == "" {
				// An empty CLASSG_DB falls back to the default rather than failing.
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error does not name %s: %v", tc.want, err)
			}
		})
	}
}

func TestBootstrapReportsAllProblems(t *testing.T) {
	_, err := LoadBootstrap(env(map[string]string{
		"CLASSG_LISTEN":              "nope",
		"CLASSG_STORE":               "postgres",
		"CLASSG_TURSO_SYNC_INTERVAL": "soon",
	}))
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("wrong error type: %T", err)
	}
	if len(ve.Problems) != 3 {
		t.Fatalf("got %d problems, want 3: %v", len(ve.Problems), ve.Problems)
	}
}

// --- Assembly ---------------------------------------------------------------

func TestAssembleDefaults(t *testing.T) {
	cfg, err := assemble(t, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SensorStaleAfter != 30*time.Second {
		t.Fatalf("SensorStaleAfter = %s", cfg.SensorStaleAfter)
	}
	if !cfg.ExposeOperatorLocation {
		t.Fatal("operator location is included by default for this deployment (ADR-0006)")
	}
	if cfg.MaxHistory != 4096 {
		t.Fatalf("MaxHistory = %d", cfg.MaxHistory)
	}
	if cfg.RetentionDetections != 168*time.Hour {
		t.Fatalf("RetentionDetections = %s", cfg.RetentionDetections)
	}
	if len(cfg.SensorRestartCommand) == 0 {
		t.Fatal("SensorRestartCommand must have a default")
	}
}

func TestSettingsFlowThroughToConfig(t *testing.T) {
	cfg, err := assemble(t, nil, map[string]string{
		"retention.tracks":             "720h",
		"sensors.stale_after":          "45s",
		"api.expose_operator_location": "false",
		"capture.wifi_interface":       "wlan1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RetentionTracks != 720*time.Hour {
		t.Fatalf("RetentionTracks = %s", cfg.RetentionTracks)
	}
	if cfg.SensorStaleAfter != 45*time.Second {
		t.Fatalf("SensorStaleAfter = %s", cfg.SensorStaleAfter)
	}
	if cfg.ExposeOperatorLocation {
		t.Fatal("stored false must win over the built-in true")
	}
	if cfg.WifiInterface != "wlan1" {
		t.Fatalf("WifiInterface = %q", cfg.WifiInterface)
	}
}

func TestEnvOverridesStoredSettings(t *testing.T) {
	b, err := LoadBootstrap(noEnv)
	if err != nil {
		t.Fatal(err)
	}
	s := resolve(t, map[string]string{"retention.tracks": "720h"},
		env(map[string]string{"CLASSG_RETENTION_TRACKS": "48h"}))
	cfg, err := Assemble(b, s)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RetentionTracks != 48*time.Hour {
		t.Fatalf("env must win: got %s", cfg.RetentionTracks)
	}
	// And it must be visible, not silent -- main logs this and the API reports it.
	if s.Source("retention.tracks") != settings.SourceEnv {
		t.Fatal("an env override must be reported as such")
	}
}

func TestAssembleValidation(t *testing.T) {
	cases := []struct {
		name string
		db   map[string]string
		want string
	}{
		{"bad endpoint scheme", map[string]string{"bus.track_endpoint": "http://x:1"}, "bus.track_endpoint"},
		{"tcp without host", map[string]string{"bus.detection_endpoint": "tcp://"}, "bus.detection_endpoint"},
		{"channel out of range", map[string]string{"capture.wifi_channel": "999"}, "capture.wifi_channel"},
		{"duration too long", map[string]string{"capture.duration_s": "99999"}, "capture.duration_s"},
		{"history below one", map[string]string{"fusion.max_history": "0"}, "fusion.max_history"},
		{"interface too long", map[string]string{"capture.wifi_interface": "averylonginterfacename"}, "capture.wifi_interface"},
		{"restart command without placeholder", map[string]string{"sensors.restart_command": "systemctl restart"}, "sensors.restart_command"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := assemble(t, nil, tc.db)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error does not name %s: %v", tc.want, err)
			}
		})
	}
}

func TestBusCanBeSwitchedOff(t *testing.T) {
	// "off" must not be treated as an invalid endpoint: a deployment with no
	// fusion still serves, and /health reports the link down (ADR-0003).
	for _, v := range []string{"off", "none", "disabled", ""} {
		cfg, err := assemble(t, nil, map[string]string{"bus.track_endpoint": v})
		if err != nil {
			t.Fatalf("%q: %v", v, err)
		}
		if v != "" && cfg.TrackEndpoint != "" {
			t.Fatalf("%q should disable the bus, got %q", v, cfg.TrackEndpoint)
		}
	}
}

func TestExpectedSensorsFlowThrough(t *testing.T) {
	cfg, err := assemble(t, nil, map[string]string{"sensors.expected": "wifi-0:wifi,sdr-0:sdr"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.ExpectedSensors) != 2 {
		t.Fatalf("got %d sensors: %+v", len(cfg.ExpectedSensors), cfg.ExpectedSensors)
	}
	if cfg.ExpectedSensors[0].SensorID != "wifi-0" {
		t.Fatalf("bad parse: %+v", cfg.ExpectedSensors)
	}
}

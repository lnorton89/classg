package config

import (
	"strings"
	"testing"
	"time"
)

func env(pairs map[string]string) func(string) string {
	return func(k string) string { return pairs[k] }
}

// TestDefaults pins the shipped behaviour of a bare `classg-api` with no
// environment at all, which is what an operator gets on first run.
func TestDefaults(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("an empty environment must be valid: %v", err)
	}
	tests := []struct {
		name string
		got  any
		want any
	}{
		{"listen", cfg.Listen, ":8081"},
		{"store", cfg.Store, StoreLibSQL},
		{"expose operator location", cfg.ExposeOperatorLocation, true},
		{"track endpoint", cfg.TrackEndpoint, "tcp://127.0.0.1:5557"},
		{"detection endpoint", cfg.DetectionEndpoint, "tcp://127.0.0.1:5556"},
		{"heartbeat topic", cfg.HeartbeatTopic, "heartbeat."},
		{"stale after", cfg.SensorStaleAfter, 30 * time.Second},
		{"detection retention", cfg.RetentionDetections, 7 * 24 * time.Hour},
		{"track retention", cfg.RetentionTracks, 90 * 24 * time.Hour},
		{"no turso url", cfg.TursoURL, ""},
	}
	for _, tc := range tests {
		if tc.got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, tc.got, tc.want)
		}
	}
}

// TestNoTursoCredentialsIsTheDefaultPath: a field deployment with no account
// and no uplink must be a valid, unremarkable configuration.
func TestNoTursoCredentialsIsTheDefaultPath(t *testing.T) {
	cfg, err := Load(env(map[string]string{"CLASSG_DB": "/var/lib/classg/classg.db"}))
	if err != nil {
		t.Fatalf("offline configuration must be valid: %v", err)
	}
	if cfg.TursoURL != "" || cfg.TursoAuthToken != "" {
		t.Fatal("no sync should be configured by default")
	}
}

func TestValidation(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string
	}{
		{
			name:    "bad listen address",
			env:     map[string]string{"CLASSG_LISTEN": "8081"},
			wantErr: "CLASSG_LISTEN",
		},
		{
			name:    "listen port out of range",
			env:     map[string]string{"CLASSG_LISTEN": ":99999"},
			wantErr: "CLASSG_LISTEN",
		},
		{
			name:    "unknown store",
			env:     map[string]string{"CLASSG_STORE": "postgres"},
			wantErr: "CLASSG_STORE",
		},
		{
			name:    "non-boolean expose flag",
			env:     map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "yes please"},
			wantErr: "CLASSG_EXPOSE_OPERATOR_LOCATION",
		},
		{
			name:    "bad duration",
			env:     map[string]string{"CLASSG_SENSOR_STALE_AFTER": "30 seconds"},
			wantErr: "CLASSG_SENSOR_STALE_AFTER",
		},
		{
			name:    "negative duration",
			env:     map[string]string{"CLASSG_RETENTION_DETECTIONS": "-1h"},
			wantErr: "CLASSG_RETENTION_DETECTIONS",
		},
		{
			name:    "bad zmq scheme",
			env:     map[string]string{"CLASSG_TRACK_ENDPOINT": "http://127.0.0.1:5557"},
			wantErr: "CLASSG_TRACK_ENDPOINT",
		},
		{
			name:    "tcp endpoint without a host",
			env:     map[string]string{"CLASSG_TRACK_ENDPOINT": "tcp://"},
			wantErr: "CLASSG_TRACK_ENDPOINT",
		},
		{
			name:    "auth token without a url",
			env:     map[string]string{"CLASSG_TURSO_AUTH_TOKEN": "secret"},
			wantErr: "CLASSG_TURSO_AUTH_TOKEN",
		},
		{
			name:    "bad turso scheme",
			env:     map[string]string{"CLASSG_TURSO_URL": "ftp://db.turso.io"},
			wantErr: "CLASSG_TURSO_URL",
		},
		{
			name:    "malformed expected sensors",
			env:     map[string]string{"CLASSG_EXPECTED_SENSORS": "wifi-0"},
			wantErr: "CLASSG_EXPECTED_SENSORS",
		},
		{
			name:    "unknown sensor kind",
			env:     map[string]string{"CLASSG_EXPECTED_SENSORS": "cam-0:camera"},
			wantErr: "sensor_kind must be wifi, sdr or ble",
		},
		{
			name:    "duplicate sensor id",
			env:     map[string]string{"CLASSG_EXPECTED_SENSORS": "wifi-0:wifi,wifi-0:wifi"},
			wantErr: "duplicate sensor_id",
		},
		{
			name:    "restart command without placeholder",
			env:     map[string]string{"CLASSG_SENSOR_RESTART_COMMAND": "systemctl restart classg"},
			wantErr: "CLASSG_SENSOR_RESTART_COMMAND",
		},
		{
			name:    "max history below one",
			env:     map[string]string{"CLASSG_MAX_HISTORY": "0"},
			wantErr: "CLASSG_MAX_HISTORY",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(env(tc.env))
			if err == nil {
				t.Fatal("want a validation error, got none")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %q does not mention %q", err, tc.wantErr)
			}
			// The message an operator reads must name the variable and be
			// free of Go internals.
			if strings.Contains(err.Error(), "goroutine") || strings.Contains(err.Error(), "0x") {
				t.Fatalf("configuration errors must be readable, got %q", err)
			}
		})
	}
}

// TestAllProblemsReported: an operator should be able to fix everything in one
// pass rather than one variable per restart.
func TestAllProblemsReported(t *testing.T) {
	_, err := Load(env(map[string]string{
		"CLASSG_LISTEN":           "nope",
		"CLASSG_STORE":            "postgres",
		"CLASSG_EXPECTED_SENSORS": "bad",
	}))
	if err == nil {
		t.Fatal("want an error")
	}
	ve, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("want *ValidationError, got %T", err)
	}
	if len(ve.Problems) < 3 {
		t.Fatalf("want every problem reported, got %d: %v", len(ve.Problems), ve.Problems)
	}
}

// TestBusCanBeSwitchedOff: running the api with no bus at all is a supported
// mode (a replay rig, a UI development server), not an error.
func TestBusCanBeSwitchedOff(t *testing.T) {
	for _, off := range []string{"off", "none", "disabled", "OFF"} {
		t.Run(off, func(t *testing.T) {
			cfg, err := Load(env(map[string]string{"CLASSG_TRACK_ENDPOINT": off}))
			if err != nil {
				t.Fatal(err)
			}
			if cfg.TrackEndpoint != "" {
				t.Fatalf("got %q, want empty", cfg.TrackEndpoint)
			}
		})
	}
}

func TestExpectedSensorsParsing(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"CLASSG_EXPECTED_SENSORS": " wifi-0:wifi , sdr-0:sdr ,",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.ExpectedSensors) != 2 {
		t.Fatalf("got %+v", cfg.ExpectedSensors)
	}
	if cfg.ExpectedSensors[0] != (SensorDecl{"wifi-0", "wifi"}) {
		t.Fatalf("got %+v", cfg.ExpectedSensors[0])
	}
}

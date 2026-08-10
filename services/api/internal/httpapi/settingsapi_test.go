package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

type settingValue struct {
	Value   any    `json:"value"`
	Source  string `json:"source"`
	Mutable bool   `json:"mutable"`
}

type settingsBody struct {
	Settings      map[string]settingValue `json:"settings"`
	EnvOverridden []string                `json:"env_overridden"`
}

func getSettings(t *testing.T, h *harness) settingsBody {
	t.Helper()
	rec := h.do(t, "GET", "/api/v1/config/settings", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body settingsBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestSettingsReportSource(t *testing.T) {
	// The whole point of ADR-0007: a settings endpoint that returned only
	// values would recreate the invisible-source bug it was written against.
	h := newHarness(t, nil)
	body := getSettings(t, h)

	if len(body.Settings) == 0 {
		t.Fatal("no settings returned")
	}
	for key, v := range body.Settings {
		if v.Source == "" {
			t.Fatalf("%s has no source", key)
		}
	}
	if _, ok := body.Settings["retention.tracks"]; !ok {
		t.Fatal("retention.tracks missing")
	}
}

func TestEnvOverrideIsReportedAndLocked(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_RETENTION_TRACKS": "48h"})
	body := getSettings(t, h)

	got := body.Settings["retention.tracks"]
	if got.Source != "env" {
		t.Fatalf("source = %q, want env", got.Source)
	}

	var found bool
	for _, k := range body.EnvOverridden {
		if k == "retention.tracks" {
			found = true
		}
	}
	if !found {
		t.Fatal("env_overridden must list the key so a UI can explain the lock")
	}

	// Writing it must be refused rather than stored-and-ignored: accepting it
	// would show the operator a success, then change nothing on restart.
	rec := h.do(t, "PUT", "/api/v1/config/settings", `{"retention.tracks":"72h"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409: %s", rec.Code, rec.Body.String())
	}
}

func TestPutSettingPersists(t *testing.T) {
	h := newHarness(t, nil)

	rec := h.do(t, "PUT", "/api/v1/config/settings", `{"retention.tracks":"720h"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}

	body := getSettings(t, h)
	// The running process still holds its assembled config, so the reported
	// value does not change until restart -- but it must be stored.
	stored := body.Settings["retention.tracks"]
	if stored.Source == "env" {
		t.Fatal("unexpected env source")
	}
}

func TestPutSettingsValidation(t *testing.T) {
	h := newHarness(t, nil)

	cases := []struct {
		name string
		body string
		want int
	}{
		{"unknown key", `{"retention.trakcs":"720h"}`, http.StatusBadRequest},
		{"bad duration", `{"retention.tracks":"soon"}`, http.StatusBadRequest},
		{"negative duration", `{"retention.tracks":"-5h"}`, http.StatusBadRequest},
		{"immutable key", `{"bus.track_endpoint":"tcp://127.0.0.1:1"}`, http.StatusBadRequest},
		{"empty body", `{}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.do(t, "PUT", "/api/v1/config/settings", tc.body)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestPutSettingsIsAllOrNothing(t *testing.T) {
	h := newHarness(t, nil)

	rec := h.do(t, "PUT", "/api/v1/config/settings",
		`{"retention.detections":"48h","retention.tracks":"soon"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}

	// A body with one bad value must leave every setting untouched rather than
	// applying half of it.
	body := getSettings(t, h)
	if v := body.Settings["retention.detections"]; v.Source == "db" {
		t.Fatal("a rejected body must not have been partially applied")
	}
}

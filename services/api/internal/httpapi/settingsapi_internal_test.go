package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/monitoring"
	"github.com/classg/api/internal/settings"
	"github.com/classg/api/internal/store/memstore"
)

// A saved setting that the next GET does not report is indistinguishable, from
// the operator's side, from a save that failed. That is what happened: PutMany
// wrote the value to the database and the resolved set this endpoint serves
// stayed at whatever startup assembled, so the settings page showed the old
// value on refresh while the new one sat correctly in the store. The operator
// concluded their change had been lost.
//
// Driven through the handlers rather than the Settings type, because the defect
// was in the seam between them: both halves were individually correct.
// This file is in package httpapi, so it cannot borrow the external test
// package's fake. One method, declared once.
type noRestart struct{}

func (noRestart) Restart(string, string) error { return nil }

func settingsServer(t *testing.T) *Server {
	t.Helper()
	env := map[string]string{
		"CLASSG_STORE":              "memory",
		"CLASSG_TRACK_ENDPOINT":     "off",
		"CLASSG_DETECTION_ENDPOINT": "off",
		"CLASSG_UI_DIR":             t.TempDir(),
	}
	getenv := func(k string) string { return env[k] }
	boot, err := config.LoadBootstrap(getenv)
	if err != nil {
		t.Fatal(err)
	}
	set, err := settings.Resolve(nil, nil, getenv)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Assemble(boot, set)
	if err != nil {
		t.Fatal(err)
	}
	st := memstore.New()
	return New(Options{
		Config: cfg, Settings: set, Store: st,
		Registry:   health.NewRegistry(cfg.SensorStaleAfter),
		Hub:        hub.New(),
		Captures:   capture.NewManager(st, capture.Options{Dir: t.TempDir()}),
		Monitoring: monitoring.New(false, time.Now().UTC()),
		Auth:       &auth.Service{Store: st, Mode: auth.ModeOff},
		Sensors:    noRestart{},
		Started:    time.Now(),
	})
}

func getSetting(t *testing.T, s *Server, key string) settings.Value {
	t.Helper()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/config/settings", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET settings: %d (%s)", w.Code, w.Body.String())
	}
	var body struct {
		Settings map[string]settings.Value `json:"settings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Settings[key]
}

func putSettings(t *testing.T, s *Server, jsonBody string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPut, "/api/v1/config/settings", strings.NewReader(jsonBody))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestASavedSettingIsReportedByTheNextRead(t *testing.T) {
	s := settingsServer(t)

	if w := putSettings(t, s, `{"sensors.stale_after":"45s"}`); w.Code != http.StatusOK {
		t.Fatalf("PUT: %d (%s)", w.Code, w.Body.String())
	}

	// Asserted on the wire form, not Value.Raw -- Raw carries `json:"-"` and
	// never leaves the process, so reading it here would have been a test of a
	// field no client can see.
	got := getSetting(t, s, "sensors.stale_after")
	if got.Value != "45s" {
		t.Errorf("after saving 45s the next read reported %#v; an operator refreshing "+
			"this page cannot tell that from a save that failed", got.Value)
	}
	if got.Source != settings.SourceDB {
		t.Errorf("source is %q, want %q", got.Source, settings.SourceDB)
	}
	// The store is the other half: it held the value even when the read did not.
	raw, err := settings.LoadFromStore(context.Background(), s.store)
	if err != nil {
		t.Fatal(err)
	}
	if raw["sensors.stale_after"] != "45s" {
		t.Errorf("the store holds %q", raw["sensors.stale_after"])
	}
}

// The typed value has to be re-resolved too, not just the raw string: this one
// serialises as a list of objects, and the settings page renders that.
func TestASavedSensorListIsReportedInItsTypedForm(t *testing.T) {
	s := settingsServer(t)

	body := `{"sensors.expected":"wifi-0:wifi,wifi-1:wifi:optional,sdr-0:sdr:optional"}`
	if w := putSettings(t, s, body); w.Code != http.StatusOK {
		t.Fatalf("PUT: %d (%s)", w.Code, w.Body.String())
	}

	got := getSetting(t, s, "sensors.expected")
	decls, ok := got.Value.([]any)
	if !ok {
		t.Fatalf("value is %T, want a list: %#v", got.Value, got.Value)
	}
	if len(decls) != 3 {
		t.Fatalf("%d declarations, want 3: %#v", len(decls), decls)
	}
	first, _ := decls[0].(map[string]any)
	if first["sensor_id"] != "wifi-0" || first["sensor_kind"] != "wifi" {
		t.Errorf("first declaration is %#v", first)
	}
	last, _ := decls[2].(map[string]any)
	if last["optional"] != true {
		t.Errorf("optional was lost re-resolving: %#v", last)
	}
}

// The PUT still says the running process has not adopted it. Stored and running
// are different facts; reporting the stored one must not start implying the
// other.
func TestSavingStillReportsThatARestartIsNeeded(t *testing.T) {
	s := settingsServer(t)
	w := putSettings(t, s, `{"sensors.stale_after":"45s"}`)
	var resp struct {
		RestartRequired bool `json:"restart_required"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.RestartRequired {
		t.Error("restart_required went false; the assembled config is still the old one")
	}
}

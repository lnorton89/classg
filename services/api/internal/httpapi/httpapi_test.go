package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/httpapi"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/memstore"
)

var base = time.Date(2026, 8, 10, 14, 0, 0, 0, time.UTC)

type fakeSensors struct{ err error }

func (f fakeSensors) Restart(string, string) error { return f.err }

type harness struct {
	server *httpapi.Server
	store  store.Store
	reg    *health.Registry
	hub    *hub.Hub
	cfg    *config.Config
}

func newHarness(t *testing.T, env map[string]string) *harness {
	t.Helper()
	if env == nil {
		env = map[string]string{}
	}
	// Tests never touch the bus or a real database.
	env["CLASSG_STORE"] = "memory"
	env["CLASSG_TRACK_ENDPOINT"] = "off"
	env["CLASSG_DETECTION_ENDPOINT"] = "off"
	if _, ok := env["CLASSG_UI_DIR"]; !ok {
		env["CLASSG_UI_DIR"] = t.TempDir() // exists but has no index.html
	}

	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	st := memstore.New()
	reg := health.NewRegistry(cfg.SensorStaleAfter)
	h := hub.New()
	caps := capture.NewManager(st, capture.Options{Dir: t.TempDir()})

	return &harness{
		server: httpapi.New(httpapi.Options{
			Config: cfg, Store: st, Registry: reg, Hub: h,
			Captures: caps, Sensors: fakeSensors{}, Started: time.Now(),
		}),
		store: st, reg: reg, hub: h, cfg: cfg,
	}
}

func (h *harness) do(t *testing.T, method, path string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.server.ServeHTTP(w, r)
	return w
}

type errEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Field   string `json:"field"`
	} `json:"error"`
}

func decodeErr(t *testing.T, w *httptest.ResponseRecorder) errEnvelope {
	t.Helper()
	var e errEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
		t.Fatalf("response is not an error envelope: %v (body %s)", err, w.Body.String())
	}
	return e
}

func seedTrack(t *testing.T, h *harness, id string, lastSeen time.Time, withOperator bool) model.Track {
	t.Helper()
	tr := model.Track{
		SchemaVersion: model.SchemaVersion,
		TrackID:       id,
		State:         "CONFIRMED",
		FirstSeen:     lastSeen.Add(-time.Minute),
		LastSeen:      lastSeen,
		Confidence:    0.82,
		Identity:      model.TrackIdentity{Serial: "SER-" + id, MACs: []string{"aa:bb:cc:dd:ee:ff"}},
	}
	if withOperator {
		tr.Operator = &model.OperatorPosition{Lat: 47.3750, Lon: 8.5400, At: lastSeen}
	}
	if err := h.store.UpsertTrack(context.Background(), tr); err != nil {
		t.Fatal(err)
	}
	return tr
}

func seedDetection(t *testing.T, h *harness, id string, ts time.Time, class string, withOperator bool) {
	t.Helper()
	d := model.Detection{
		SchemaVersion:  model.SchemaVersion,
		DetectionID:    id,
		TS:             model.FlexTime{Time: ts},
		SensorID:       "wifi-0",
		SensorKind:     "wifi",
		DetectionClass: class,
	}
	d.Identity.Serial = "SER-T1"
	d.Identity.MAC = "aa:bb:cc:dd:ee:ff"
	if withOperator {
		d.Operator = &model.OperatorPosition{Lat: 47.3750, Lon: 8.5400}
	}
	if err := h.store.InsertDetection(context.Background(), d); err != nil {
		t.Fatal(err)
	}
}

// --- error envelope --------------------------------------------------------

// TestErrorEnvelope walks every code in the contract's list that the HTTP
// layer can produce, and asserts the shape is identical each time. A client
// parses one shape or it parses none.
func TestErrorEnvelope(t *testing.T) {
	h := newHarness(t, nil)
	seedTrack(t, h, "T1", base, false)

	tests := []struct {
		name       string
		method     string
		path       string
		body       string
		wantStatus int
		wantCode   string
		wantField  string
	}{
		{"unknown endpoint", "GET", "/api/v1/nope", "", 404, "not_found", ""},
		{"unknown api version", "GET", "/api/v2/tracks", "", 404, "not_found", ""},
		{"wrong method", "DELETE", "/api/v1/tracks", "", 404, "not_found", ""},
		{"unknown track", "GET", "/api/v1/tracks/missing", "", 404, "not_found", ""},
		{"unknown track detections", "GET", "/api/v1/tracks/missing/detections", "", 404, "not_found", ""},
		{"unknown capture", "GET", "/api/v1/captures/missing", "", 404, "not_found", ""},
		{"unanalysed capture report", "GET", "/api/v1/captures/missing/report", "", 404, "not_found", ""},
		{"unknown sensor restart", "POST", "/api/v1/sensors/nope/restart", "", 404, "not_found", ""},
		{"bad limit", "GET", "/api/v1/tracks?limit=abc", "", 400, "invalid_parameter", "limit"},
		{"limit too large", "GET", "/api/v1/tracks?limit=1001", "", 400, "invalid_parameter", "limit"},
		{"bad state", "GET", "/api/v1/tracks?state=CONFIRMD", "", 400, "invalid_parameter", "state"},
		{"bad since", "GET", "/api/v1/tracks?since=yesterday", "", 400, "invalid_parameter", "since"},
		{"bad min_confidence", "GET", "/api/v1/tracks?min_confidence=2", "", 400, "invalid_parameter", "min_confidence"},
		{"bad cursor", "GET", "/api/v1/tracks?cursor=!!!", "", 400, "invalid_parameter", "cursor"},
		{"bad class", "GET", "/api/v1/detections?class=Z", "", 400, "invalid_parameter", "class"},
		{"bad capture body", "POST", "/api/v1/captures", `{"iface":"","channel":6}`, 400, "invalid_parameter", "iface"},
		{"bad capture channel", "POST", "/api/v1/captures", `{"iface":"wlan1","channel":99}`, 400, "invalid_parameter", "channel"},
		{"unknown body field", "POST", "/api/v1/captures", `{"iface":"wlan1","transmit":true}`, 400, "invalid_parameter", ""},
		{"bad channel config", "PUT", "/api/v1/config/channels", `{"channels":[]}`, 400, "invalid_parameter", "channels"},
		{"bad weight class", "PUT", "/api/v1/config/weights", `{"weights":{"Z":0.5}}`, 400, "invalid_parameter", "weights.Z"},
		{"weight out of range", "PUT", "/api/v1/config/weights", `{"weights":{"A":1.5}}`, 400, "invalid_parameter", "weights.A"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := h.do(t, tc.method, tc.path, tc.body)
			if w.Code != tc.wantStatus {
				t.Fatalf("status: got %d want %d (body %s)", w.Code, tc.wantStatus, w.Body.String())
			}
			if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Fatalf("content type: got %q", ct)
			}
			e := decodeErr(t, w)
			if e.Error.Code != tc.wantCode {
				t.Errorf("code: got %q want %q", e.Error.Code, tc.wantCode)
			}
			if e.Error.Message == "" {
				t.Error("every error must carry a message")
			}
			if tc.wantField != "" && e.Error.Field != tc.wantField {
				t.Errorf("field: got %q want %q", e.Error.Field, tc.wantField)
			}
		})
	}
}

// TestErrorEnvelopeMessageMatchesContract pins the one message the contract
// prints verbatim, so a client that matches on it is not surprised.
func TestErrorEnvelopeMessageMatchesContract(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(t, "GET", "/api/v1/tracks?limit=1001", "")
	e := decodeErr(t, w)
	if e.Error.Message != "limit must be <= 1000" {
		t.Fatalf("got %q want %q", e.Error.Message, "limit must be <= 1000")
	}
}

// --- operator location -----------------------------------------------------

// TestOperatorLocationExposure covers both paths of
// CLASSG_EXPOSE_OPERATOR_LOCATION across every endpoint that can carry it.
func TestOperatorLocationExposure(t *testing.T) {
	for _, expose := range []bool{true, false} {
		t.Run(fmt.Sprintf("expose=%v", expose), func(t *testing.T) {
			h := newHarness(t, map[string]string{
				"CLASSG_EXPOSE_OPERATOR_LOCATION": fmt.Sprint(expose),
			})
			seedTrack(t, h, "T1", base, true)
			seedDetection(t, h, "D1", base, "A", true)

			paths := []string{
				"/api/v1/tracks",
				"/api/v1/tracks/T1",
				"/api/v1/tracks/T1/detections",
				"/api/v1/detections",
			}
			for _, path := range paths {
				t.Run(path, func(t *testing.T) {
					w := h.do(t, "GET", path, "")
					if w.Code != 200 {
						t.Fatalf("status %d: %s", w.Code, w.Body.String())
					}
					body := w.Body.String()
					hasOperator := strings.Contains(body, `"operator"`)
					if hasOperator != expose {
						t.Fatalf("operator present=%v, want %v\nbody: %s", hasOperator, expose, body)
					}
					// The coordinates themselves must not leak by another name.
					if !expose && strings.Contains(body, "8.54") {
						t.Fatalf("operator coordinates leaked into a redacted response: %s", body)
					}
				})
			}
		})
	}
}

// TestOperatorAbsenceIsNotAnError: a client must be able to parse a response
// with no operator field at all, which is the default the schema documents.
func TestOperatorAbsenceIsNotAnError(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "true"})
	seedTrack(t, h, "T1", base, false) // no operator recorded at all

	w := h.do(t, "GET", "/api/v1/tracks/T1", "")
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	var tr model.Track
	if err := json.Unmarshal(w.Body.Bytes(), &tr); err != nil {
		t.Fatal(err)
	}
	if tr.Operator != nil {
		t.Fatal("no operator was recorded, so none should be reported")
	}
}

// --- pagination ------------------------------------------------------------

func TestPaginationBounds(t *testing.T) {
	h := newHarness(t, nil)
	for i := 0; i < 5; i++ {
		seedTrack(t, h, fmt.Sprintf("T%02d", i), base.Add(-time.Duration(i)*time.Minute), false)
	}

	tests := []struct {
		name      string
		query     string
		wantCode  int
		wantCount int
	}{
		{"default limit", "", 200, 5},
		{"explicit limit", "?limit=2", 200, 2},
		{"limit at maximum", "?limit=1000", 200, 5},
		{"limit one", "?limit=1", 200, 1},
		{"limit above maximum", "?limit=1001", 400, 0},
		{"limit zero", "?limit=0", 400, 0},
		{"limit negative", "?limit=-1", 400, 0},
		{"limit not a number", "?limit=1.5", 400, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := h.do(t, "GET", "/api/v1/tracks"+tc.query, "")
			if w.Code != tc.wantCode {
				t.Fatalf("status: got %d want %d (%s)", w.Code, tc.wantCode, w.Body.String())
			}
			if tc.wantCode != 200 {
				return
			}
			var resp struct {
				Tracks     []model.Track `json:"tracks"`
				NextCursor *string       `json:"next_cursor"`
				Total      int           `json:"total"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatal(err)
			}
			if len(resp.Tracks) != tc.wantCount {
				t.Fatalf("tracks: got %d want %d", len(resp.Tracks), tc.wantCount)
			}
			if resp.Total != 5 {
				t.Fatalf("total should be the unpaged count: got %d", resp.Total)
			}
		})
	}
}

// TestPaginationWalk follows next_cursor to the end and asserts the pages
// partition the data exactly.
func TestPaginationWalk(t *testing.T) {
	h := newHarness(t, nil)
	const n = 7
	for i := 0; i < n; i++ {
		seedTrack(t, h, fmt.Sprintf("T%02d", i), base.Add(-time.Duration(i)*time.Minute), false)
	}

	seen := map[string]int{}
	query := "?limit=3"
	for i := 0; ; i++ {
		if i > 5 {
			t.Fatal("pagination did not terminate")
		}
		w := h.do(t, "GET", "/api/v1/tracks"+query, "")
		if w.Code != 200 {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Tracks     []model.Track `json:"tracks"`
			NextCursor *string       `json:"next_cursor"`
			Total      int           `json:"total"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		for _, tr := range resp.Tracks {
			seen[tr.TrackID]++
		}
		if resp.NextCursor == nil {
			break
		}
		query = "?limit=3&cursor=" + *resp.NextCursor
	}
	if len(seen) != n {
		t.Fatalf("walked %d tracks, want %d", len(seen), n)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("%s appeared %d times", id, count)
		}
	}
}

// TestNextCursorIsNullWhenExhausted pins the contract's example, which shows
// `"next_cursor": null` rather than an empty string.
func TestNextCursorIsNullWhenExhausted(t *testing.T) {
	h := newHarness(t, nil)
	seedTrack(t, h, "T1", base, false)
	w := h.do(t, "GET", "/api/v1/tracks", "")
	if !strings.Contains(w.Body.String(), `"next_cursor":null`) {
		t.Fatalf("want next_cursor null, got %s", w.Body.String())
	}
}

// --- health ----------------------------------------------------------------

// TestHealthEndpointDistinguishesQuietFromBroken is the HTTP-level version of
// the property the whole service exists for.
func TestHealthEndpointDistinguishesQuietFromBroken(t *testing.T) {
	tests := []struct {
		name       string
		heartbeat  *health.Heartbeat
		wantStatus string
	}{
		{
			name:       "healthy sensor, no detections: quiet sky",
			heartbeat:  &health.Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: time.Now()},
			wantStatus: "ok",
		},
		{
			name: "unhealthy sensor, no detections: do not trust the quiet",
			heartbeat: &health.Heartbeat{
				SensorID: "wifi-0", SensorKind: "wifi", Healthy: false, TS: time.Now(),
				Detail: map[string]any{"reason": "device not found"},
			},
			wantStatus: "down",
		},
		{
			name:       "no sensors known at all",
			heartbeat:  nil,
			wantStatus: "down",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, nil)
			if tc.heartbeat != nil {
				h.reg.Heartbeat(*tc.heartbeat)
			}
			w := h.do(t, "GET", "/api/v1/health", "")
			if w.Code != 200 {
				t.Fatalf("health must always return 200 so the verdict is readable; got %d", w.Code)
			}
			var rep health.Report
			if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
				t.Fatal(err)
			}
			if rep.Status != tc.wantStatus {
				t.Fatalf("status: got %q want %q", rep.Status, tc.wantStatus)
			}
			if rep.Version == "" {
				t.Error("version must be reported")
			}
		})
	}
}

func TestHealthReportsDetectionCounts(t *testing.T) {
	h := newHarness(t, nil)
	h.reg.Heartbeat(health.Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: time.Now()})
	seedDetection(t, h, "D1", time.Now().Add(-time.Minute), "A", false)
	seedDetection(t, h, "D2", time.Now().Add(-time.Hour), "A", false) // outside the 5 m window

	w := h.do(t, "GET", "/api/v1/health", "")
	var rep health.Report
	if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	if len(rep.Sensors) != 1 || rep.Sensors[0].Detections5m != 1 {
		t.Fatalf("detections_5m: %+v", rep.Sensors)
	}
}

// --- sensors ---------------------------------------------------------------

func TestSensorsAndRestart(t *testing.T) {
	h := newHarness(t, map[string]string{
		"CLASSG_WIFI_INTERFACE":     "wlan-test",
		"CLASSG_WIFI_CHANNEL":       "11",
		"CLASSG_CAPTURE_DURATION_S": "45",
		"CLASSG_CAPTURE_LABEL":      "flight-test",
	})
	h.reg.Heartbeat(health.Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: time.Now()})

	w := h.do(t, "GET", "/api/v1/sensors", "")
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	var resp struct {
		Sensors []struct {
			SensorID string `json:"sensor_id"`
			Config   struct {
				Unit    string `json:"unit"`
				Capture struct {
					Supported bool   `json:"supported"`
					Interface string `json:"interface"`
					Channel   int    `json:"channel"`
					DurationS int    `json:"duration_s"`
					Label     string `json:"label"`
				} `json:"capture"`
			} `json:"config"`
		} `json:"sensors"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Sensors) != 1 || resp.Sensors[0].Config.Unit != "classg-sensor-wifi.service" {
		t.Fatalf("sensors: %+v", resp.Sensors)
	}
	captureCfg := resp.Sensors[0].Config.Capture
	if !captureCfg.Supported || captureCfg.Interface != "wlan-test" || captureCfg.Channel != 11 ||
		captureCfg.DurationS != 45 || captureCfg.Label != "flight-test" {
		t.Fatalf("capture config did not round-trip from env: %+v", captureCfg)
	}

	w = h.do(t, "POST", "/api/v1/sensors/wifi-0/restart", "")
	if w.Code != 202 {
		t.Fatalf("restart: got %d want 202 (%s)", w.Code, w.Body.String())
	}
}

func TestCaptureInterfaceMustMatchEnvironment(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_WIFI_INTERFACE": "wlan-test"})
	w := h.do(t, "POST", "/api/v1/captures", `{"iface":"wlan0","channel":6,"duration_s":5}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d want 400 (%s)", w.Code, w.Body.String())
	}
	err := decodeErr(t, w)
	if err.Error.Field != "iface" || !strings.Contains(err.Error.Message, "wlan-test") {
		t.Fatalf("unexpected error: %+v", err.Error)
	}
}

// --- config ----------------------------------------------------------------

func TestConfigRoundTrip(t *testing.T) {
	h := newHarness(t, nil)

	// Defaults are served before anything has been written.
	w := h.do(t, "GET", "/api/v1/config/channels", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"channel":6`) {
		t.Fatalf("default channel plan: %d %s", w.Code, w.Body.String())
	}

	w = h.do(t, "PUT", "/api/v1/config/channels",
		`{"channels":[{"channel":6,"freq_mhz":2437,"weight":100}]}`)
	if w.Code != 200 {
		t.Fatalf("put channels: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		RestartRequired bool `json:"restart_required"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.RestartRequired {
		t.Error("channel changes need a sensor restart until sensors can be pushed config")
	}

	w = h.do(t, "GET", "/api/v1/config/channels", "")
	if !strings.Contains(w.Body.String(), `"weight":100`) {
		t.Fatalf("stored plan not returned: %s", w.Body.String())
	}
}

// TestWeightOfOneIsRejected guards the confidence model: noisy-OR is chosen
// precisely so no single evidence class can manufacture certainty.
func TestWeightOfOneIsRejected(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(t, "PUT", "/api/v1/config/weights", `{"weights":{"A":1.0}}`)
	if w.Code != 400 {
		t.Fatalf("got %d want 400 (%s)", w.Code, w.Body.String())
	}
	e := decodeErr(t, w)
	if e.Error.Field != "weights.A" {
		t.Fatalf("field: got %q", e.Error.Field)
	}
}

// --- captures --------------------------------------------------------------

// TestCaptureDownloadStreamsPcap covers the download endpoint and the
// Content-Disposition filename a desktop Wireshark user ends up with.
func TestCaptureDownloadStreamsPcap(t *testing.T) {
	dir := t.TempDir()
	h := newHarness(t, map[string]string{"CLASSG_CAPTURE_DIR": dir})
	// Rebuild the server with a capture manager rooted at the same directory.
	caps := capture.NewManager(h.store, capture.Options{Dir: dir})
	h.server = httpapi.New(httpapi.Options{
		Config: h.cfg, Store: h.store, Registry: h.reg, Hub: h.hub,
		Captures: caps, Sensors: fakeSensors{}, Started: time.Now(),
	})

	c := model.Capture{
		CaptureID: "C1", Filename: "2026-08-10-first-flight.pcap",
		State: model.CaptureCompleted, StartedAt: base, Iface: "wlan1", Channel: 6,
	}
	if err := h.store.PutCapture(context.Background(), c); err != nil {
		t.Fatal(err)
	}

	// Missing file: 404 with the envelope, not a stack trace.
	w := h.do(t, "GET", "/api/v1/captures/C1/download", "")
	if w.Code != 404 {
		t.Fatalf("missing file: got %d want 404", w.Code)
	}

	writeFile(t, dir, c.Filename, "\xd4\xc3\xb2\xa1fake pcap bytes")

	w = h.do(t, "GET", "/api/v1/captures/C1/download", "")
	if w.Code != 200 {
		t.Fatalf("download: got %d (%s)", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/vnd.tcpdump.pcap" {
		t.Errorf("content type: got %q", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, c.Filename) {
		t.Errorf("content disposition: got %q", cd)
	}
	if !strings.Contains(w.Body.String(), "fake pcap bytes") {
		t.Errorf("body was not the file")
	}
}

func TestCapturesListIsEmptyArrayNotNull(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(t, "GET", "/api/v1/captures", "")
	if got := strings.TrimSpace(w.Body.String()); got != `{"captures":[]}` {
		t.Fatalf("got %s", got)
	}
}

// --- static ----------------------------------------------------------------

// TestNoWebAppStillAnswersInTheEnvelope: a deployment without a built UI must
// not serve a blank page or an HTML error to an API client.
func TestNoWebAppStillAnswersInTheEnvelope(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(t, "GET", "/", "")
	if w.Code != 404 {
		t.Fatalf("got %d want 404", w.Code)
	}
	e := decodeErr(t, w)
	if e.Error.Code != "not_found" {
		t.Fatalf("code: %q", e.Error.Code)
	}
}

func TestWebAppIsServedWhenBuilt(t *testing.T) {
	uiDir := t.TempDir()
	writeFile(t, uiDir, "index.html", "<!doctype html><title>classg</title>")
	writeFile(t, uiDir, "app.js", "console.log(1)")

	h := newHarness(t, map[string]string{"CLASSG_UI_DIR": uiDir})

	tests := []struct {
		path     string
		wantCode int
		wantBody string
	}{
		{"/", 200, "<title>classg</title>"},
		{"/app.js", 200, "console.log(1)"},
		// A client-side route has no extension and falls back to index.html.
		{"/tracks/01J8XR", 200, "<title>classg</title>"},
		// A missing asset must 404 rather than return HTML with a 200.
		{"/missing.js", 404, ""},
	}
	for _, tc := range tests {
		t.Run(tc.path, func(t *testing.T) {
			w := h.do(t, "GET", tc.path, "")
			if w.Code != tc.wantCode {
				t.Fatalf("got %d want %d", w.Code, tc.wantCode)
			}
			if tc.wantBody != "" && !strings.Contains(w.Body.String(), tc.wantBody) {
				t.Fatalf("body: %s", w.Body.String())
			}
		})
	}
}

// TestAPIPathsAreNotSwallowedByTheWebApp: the SPA fallback must never shadow
// the API, or a typo'd endpoint would return HTML with a 200.
func TestAPIPathsAreNotSwallowedByTheWebApp(t *testing.T) {
	uiDir := t.TempDir()
	writeFile(t, uiDir, "index.html", "<!doctype html>")
	h := newHarness(t, map[string]string{"CLASSG_UI_DIR": uiDir})

	w := h.do(t, "GET", "/api/v1/nope", "")
	if w.Code != 404 {
		t.Fatalf("got %d want 404", w.Code)
	}
	if strings.Contains(w.Body.String(), "doctype") {
		t.Fatalf("the web app swallowed an API path: %s", w.Body.String())
	}
}

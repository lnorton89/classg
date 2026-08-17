package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/health"
)

func healthHeartbeat(id, kind string, detail map[string]any) health.Heartbeat {
	return health.Heartbeat{
		SensorID:   id,
		SensorKind: kind,
		Healthy:    true,
		TS:         time.Now().UTC(),
		At:         time.Now(),
		Detail:     detail,
	}
}

func scrape(t *testing.T, h *harness) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /metrics = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("Content-Type = %q, want text/plain", ct)
	}
	return rec.Body.String()
}

func TestMetricsExposesStatusAndUptime(t *testing.T) {
	body := scrape(t, newHarness(t, nil))

	for _, want := range []string{
		"# TYPE classg_status gauge",
		`classg_status{status="ok"}`,
		`classg_status{status="degraded"}`,
		`classg_status{status="down"}`,
		"classg_uptime_seconds ",
		"classg_fusion_connected ",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in:\n%s", want, body)
		}
	}
}

// Every metric family must carry HELP and TYPE exactly once, and no sample line
// may appear before them. A scraper tolerates a lot, but a repeated TYPE for
// one family is a hard parse error.
func TestMetricsFamiliesAreWellFormed(t *testing.T) {
	body := scrape(t, newHarness(t, nil))

	typeCount := map[string]int{}
	declared := map[string]bool{}
	for _, line := range strings.Split(body, "\n") {
		switch {
		case strings.HasPrefix(line, "# TYPE "):
			name := strings.Fields(line)[2]
			typeCount[name]++
			declared[name] = true
		case line == "" || strings.HasPrefix(line, "#"):
		default:
			name, _, _ := strings.Cut(line, "{")
			name, _, _ = strings.Cut(name, " ")
			if !declared[name] {
				t.Fatalf("sample for %q appears before its TYPE:\n%s", name, body)
			}
		}
	}
	for name, n := range typeCount {
		if n != 1 {
			t.Fatalf("family %q declared %d times, want 1", name, n)
		}
	}
}

// The detail blob is whatever a sensor chose to publish, and /metrics is the
// endpoint most likely to be scraped somewhere else entirely. ADR-0006 makes
// the operator's position the field that must never leave by accident, so the
// export is an allowlist and this is the test that keeps it one.
func TestMetricsDoesNotExportUnlistedDetailKeys(t *testing.T) {
	h := newHarness(t, nil)
	h.reg.Heartbeat(healthHeartbeat("wifi-0", "wifi", map[string]any{
		"listening_fraction": 0.93,
		"hops":               41,
		"operator_lat":       51.5074,
		"operator_lon":       -0.1278,
		"secret_note":        "should never be scraped",
	}))

	body := scrape(t, h)

	if !strings.Contains(body, "classg_wifi_listening_fraction") {
		t.Fatalf("allowlisted key missing:\n%s", body)
	}
	for _, leak := range []string{"operator_lat", "operator_lon", "51.5074", "-0.1278", "secret_note"} {
		if strings.Contains(body, leak) {
			t.Fatalf("unlisted detail key %q leaked into /metrics:\n%s", leak, body)
		}
	}
}

// Sensor IDs arrive off the bus. One containing a quote would otherwise end the
// label early and corrupt every line that followed.
func TestMetricsEscapesLabelValues(t *testing.T) {
	h := newHarness(t, nil)
	h.reg.Heartbeat(healthHeartbeat(`wifi"0`, "wifi", map[string]any{"hops": 1}))

	body := scrape(t, h)

	if !strings.Contains(body, `sensor_id="wifi\"0"`) {
		t.Fatalf("label value not escaped:\n%s", body)
	}
}

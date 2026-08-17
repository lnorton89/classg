package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/classg/api/internal/store"
)

func getTelemetry(t *testing.T, h *harness, query string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/telemetry"+query, nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response was not JSON: %v\n%s", err, rec.Body.String())
	}
	return rec.Code, body
}

func TestTelemetryReturnsSamplesInTheWindow(t *testing.T) {
	h := newHarness(t, nil)
	now := time.Now().UTC()
	temp := 46.25

	for i, ts := range []time.Time{now.Add(-2 * time.Hour), now.Add(-time.Minute)} {
		sample := store.TelemetrySample{TS: ts}
		if i == 1 {
			sample.CPUTempC = &temp
		}
		if err := h.store.InsertTelemetry(context.Background(), sample); err != nil {
			t.Fatal(err)
		}
	}

	code, body := getTelemetry(t, h, "?window=6h")
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", code, body)
	}
	samples, _ := body["samples"].([]any)
	if len(samples) != 2 {
		t.Fatalf("want 2 samples in a 6h window, got %d", len(samples))
	}

	code, body = getTelemetry(t, h, "?window=30m")
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	samples, _ = body["samples"].([]any)
	if len(samples) != 1 {
		t.Fatalf("want 1 sample in a 30m window, got %d", len(samples))
	}
}

// The whole point of the pointer types. A reading the api could not take must
// arrive as JSON null so a chart draws a gap; 0 would plot a cold Pi.
func TestTelemetryUnreadableFiguresSerialiseAsNull(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.store.InsertTelemetry(context.Background(), store.TelemetrySample{
		TS: time.Now().UTC().Add(-time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	_, body := getTelemetry(t, h, "")
	samples, _ := body["samples"].([]any)
	if len(samples) != 1 {
		t.Fatalf("want 1 sample, got %d", len(samples))
	}
	sample, _ := samples[0].(map[string]any)

	for _, field := range []string{"cpu_temp_c", "load1", "mem_available_kb", "disk_free_bytes"} {
		v, present := sample[field]
		if !present {
			t.Fatalf("%s must be present as null rather than omitted", field)
		}
		if v != nil {
			t.Fatalf("%s = %v, want null for an unreadable figure", field, v)
		}
	}
}

func TestTelemetryRejectsAnUnusableWindow(t *testing.T) {
	h := newHarness(t, nil)

	for _, q := range []string{"?window=nonsense", "?window=-1h", "?window=99999h"} {
		code, _ := getTelemetry(t, h, q)
		if code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", q, code)
		}
	}
}

func TestTelemetryReportsAnEmptyWindowAsEmptyRatherThanNull(t *testing.T) {
	h := newHarness(t, nil)

	code, body := getTelemetry(t, h, "?window=1h")
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	// A JSON null here would make every consumer write a nil check for a case
	// that just means "nothing recorded yet".
	samples, ok := body["samples"].([]any)
	if !ok {
		t.Fatalf("samples = %v, want an array", body["samples"])
	}
	if len(samples) != 0 {
		t.Fatalf("want no samples, got %d", len(samples))
	}
}

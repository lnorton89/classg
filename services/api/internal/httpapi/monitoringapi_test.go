package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

type monitoringState struct {
	Enabled   bool   `json:"enabled"`
	Reason    string `json:"reason"`
	Discarded int64  `json:"discarded_while_paused"`
}

func getMonitoring(t *testing.T, h *harness) monitoringState {
	t.Helper()
	rec := h.do(t, "GET", "/api/v1/monitoring", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var st monitoringState
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestRecordingIsOnByDefault(t *testing.T) {
	h := newHarness(t, nil)
	if !getMonitoring(t, h).Enabled {
		t.Fatal("a fresh system must be recording without anyone asking it to")
	}
}

func TestPauseAndResumeOverHTTP(t *testing.T) {
	h := newHarness(t, nil)

	rec := h.do(t, "PUT", "/api/v1/monitoring", `{"enabled":false,"reason":"bench testing"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	st := getMonitoring(t, h)
	if st.Enabled {
		t.Fatal("should be paused")
	}
	if st.Reason != "bench testing" {
		t.Fatalf("reason = %q", st.Reason)
	}

	h.do(t, "PUT", "/api/v1/monitoring", `{"enabled":true}`)
	if !getMonitoring(t, h).Enabled {
		t.Fatal("should be recording again")
	}
}

func TestPausedIngestionIsCountedNotSilent(t *testing.T) {
	// The point: a paused system must be distinguishable from a quiet sky.
	h := newHarness(t, nil)
	h.do(t, "PUT", "/api/v1/monitoring", `{"enabled":false}`)

	h.ingestDetection(t, sampleDetection("01JCLASSGDETECTION000000001"))
	h.ingestDetection(t, sampleDetection("01JCLASSGDETECTION000000002"))

	st := getMonitoring(t, h)
	if st.Discarded != 2 {
		t.Fatalf("discarded = %d, want 2", st.Discarded)
	}

	rec := h.do(t, "GET", "/api/v1/detections", "")
	var page struct {
		Total int `json:"total"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &page)
	if page.Total != 0 {
		t.Fatalf("paused recording still stored %d detections", page.Total)
	}
}

func TestResumingRecordsAgain(t *testing.T) {
	h := newHarness(t, nil)
	h.do(t, "PUT", "/api/v1/monitoring", `{"enabled":false}`)
	h.ingestDetection(t, sampleDetection("01JCLASSGDETECTION000000003"))
	h.do(t, "PUT", "/api/v1/monitoring", `{"enabled":true}`)
	h.ingestDetection(t, sampleDetection("01JCLASSGDETECTION000000004"))

	rec := h.do(t, "GET", "/api/v1/detections", "")
	var page struct {
		Total int `json:"total"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &page)
	if page.Total != 1 {
		t.Fatalf("expected exactly the post-resume detection, got %d", page.Total)
	}
}

func TestOverlongReasonRejected(t *testing.T) {
	h := newHarness(t, nil)
	long := make([]byte, 250)
	for i := range long {
		long[i] = 'x'
	}
	rec := h.do(t, "PUT", "/api/v1/monitoring",
		`{"enabled":false,"reason":"`+string(long)+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}

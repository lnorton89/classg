package httpapi

import (
	"net/http"
	"time"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/store"
)

const (
	// defaultTelemetryWindow is what the About panel opens on: long enough to
	// show an evening's thermal behaviour, short enough to draw quickly.
	defaultTelemetryWindow = 6 * time.Hour
	maxTelemetryWindow     = 30 * 24 * time.Hour
	// maxTelemetrySamples bounds one response. A week at the default sampling
	// interval is about ten thousand samples, so this is a real ceiling rather
	// than a formality -- and the response says when it bit.
	maxTelemetrySamples = 5000
)

type telemetrySensorOut struct {
	SensorID   string             `json:"sensor_id"`
	SensorKind string             `json:"sensor_kind"`
	Healthy    bool               `json:"healthy"`
	Metrics    map[string]float64 `json:"metrics,omitempty"`
}

type telemetrySampleOut struct {
	TS             time.Time            `json:"ts"`
	CPUTempC       *float64             `json:"cpu_temp_c"`
	Load1          *float64             `json:"load1"`
	MemAvailableKB *int64               `json:"mem_available_kb"`
	DiskFreeBytes  *int64               `json:"disk_free_bytes"`
	UptimeS        *int64               `json:"uptime_s"`
	Sensors        []telemetrySensorOut `json:"sensors,omitempty"`
}

type telemetryResponse struct {
	Samples []telemetrySampleOut `json:"samples"`
	Since   time.Time            `json:"since"`
	Until   time.Time            `json:"until"`
	// Truncated says the window held more samples than were returned, so a
	// chart can say so instead of quietly drawing a shorter period than its
	// axis claims.
	Truncated bool `json:"truncated"`
}

// handleTelemetry serves recorded host and sensor history.
//
// Nulls survive to the client. A sample where the CPU temperature could not be
// read carries null, not 0, so a chart draws a gap rather than a cold Pi --
// the same rule /system follows for the instantaneous reading.
func (s *Server) handleTelemetry(w http.ResponseWriter, r *http.Request) {
	until := time.Now().UTC()
	window := defaultTelemetryWindow

	if raw := r.URL.Query().Get("window"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			fail(w, apierr.InvalidParameter("window", "must be a positive duration, for example 6h or 90m"))
			return
		}
		if d > maxTelemetryWindow {
			fail(w, apierr.InvalidParameter("window", "must be at most 720h"))
			return
		}
		window = d
	}

	since, err := timeParam(r, "since")
	if err != nil {
		fail(w, err)
		return
	}
	if since.IsZero() {
		since = until.Add(-window)
	}
	if since.After(until) {
		fail(w, apierr.InvalidParameter("since", "must be before now"))
		return
	}

	// One over the cap, so truncation can be reported rather than inferred.
	samples, err := s.store.ListTelemetry(r.Context(), store.TelemetryQuery{
		Since: since,
		Until: until,
		Limit: maxTelemetrySamples + 1,
	})
	if err != nil {
		fail(w, err)
		return
	}

	truncated := len(samples) > maxTelemetrySamples
	if truncated {
		samples = samples[:maxTelemetrySamples]
	}

	out := make([]telemetrySampleOut, 0, len(samples))
	for _, sample := range samples {
		sensors := make([]telemetrySensorOut, 0, len(sample.Sensors))
		for _, sensor := range sample.Sensors {
			sensors = append(sensors, telemetrySensorOut(sensor))
		}
		out = append(out, telemetrySampleOut{
			TS:             sample.TS,
			CPUTempC:       sample.CPUTempC,
			Load1:          sample.Load1,
			MemAvailableKB: sample.MemAvailableKB,
			DiskFreeBytes:  sample.DiskFreeBytes,
			UptimeS:        sample.UptimeS,
			Sensors:        sensors,
		})
	}

	writeJSON(w, http.StatusOK, telemetryResponse{
		Samples:   out,
		Since:     since,
		Until:     until,
		Truncated: truncated,
	})
}

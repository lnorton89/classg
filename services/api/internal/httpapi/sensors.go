package httpapi

import (
	"errors"
	"net/http"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/health"
)

// sensorConfig is the "with full config" part of GET /sensors that the
// contract asks for beyond the /health array.
type sensorConfig struct {
	Unit           string `json:"unit"`
	StaleAfterS    int    `json:"stale_after_s"`
	Expected       bool   `json:"expected"`
	RestartCommand string `json:"restart_command"`
}

type sensorEntry struct {
	health.Sensor
	Config sensorConfig `json:"config"`
}

type sensorsResponse struct {
	Sensors []sensorEntry `json:"sensors"`
}

func (s *Server) handleListSensors(w http.ResponseWriter, r *http.Request) {
	rep := s.Health(r.Context())
	expected := map[string]bool{}
	for _, d := range s.cfg.ExpectedSensors {
		expected[d.SensorID] = true
	}

	out := make([]sensorEntry, 0, len(rep.Sensors))
	for _, sensor := range rep.Sensors {
		out = append(out, sensorEntry{
			Sensor: sensor,
			Config: sensorConfig{
				Unit:           unitFor(sensor.SensorKind),
				StaleAfterS:    int(s.cfg.SensorStaleAfter.Seconds()),
				Expected:       expected[sensor.SensorID],
				RestartCommand: restartCommandString(s.cfg.SensorRestartCommand, unitFor(sensor.SensorKind)),
			},
		})
	}
	writeJSON(w, http.StatusOK, sensorsResponse{Sensors: out})
}

type restartResponse struct {
	SensorID string `json:"sensor_id"`
	Unit     string `json:"unit"`
	Accepted bool   `json:"accepted"`
}

func (s *Server) handleRestartSensor(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("sensor_id")

	rep := s.Health(r.Context())
	kind := ""
	for _, sensor := range rep.Sensors {
		if sensor.SensorID == id {
			kind = sensor.SensorKind
			break
		}
	}
	if kind == "" {
		fail(w, apierr.NotFound("no sensor with id "+id))
		return
	}

	// Restart only. There is deliberately no start/stop pair and no way to
	// pass arguments through: the unit name is derived from a validated
	// sensor kind, never from the request.
	if err := s.sensors.Restart(id, kind); err != nil {
		if errors.Is(err, errRestartUnavailable) {
			fail(w, apierr.PrivilegesRequired(err.Error()))
			return
		}
		fail(w, apierr.SensorUnavailable(err.Error()))
		return
	}
	writeJSON(w, http.StatusAccepted, restartResponse{SensorID: id, Unit: unitFor(kind), Accepted: true})
}

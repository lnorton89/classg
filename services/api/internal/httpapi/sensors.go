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
	Unit                     string        `json:"unit"`
	StaleAfterS              int           `json:"stale_after_s"`
	Expected                 bool          `json:"expected"`
	RestartCommand           string        `json:"restart_command"`
	RestartAvailable         bool          `json:"restart_available"`
	RestartUnavailableReason string        `json:"restart_unavailable_reason,omitempty"`
	Capture                  captureConfig `json:"capture"`
}

type captureConfig struct {
	Supported bool   `json:"supported"`
	Interface string `json:"interface,omitempty"`
	Channel   int    `json:"channel,omitempty"`
	DurationS int    `json:"duration_s,omitempty"`
	Label     string `json:"label,omitempty"`
}

type sensorEntry struct {
	health.Sensor
	Config sensorConfig `json:"config"`
}

type sensorsResponse struct {
	Sensors []sensorEntry `json:"sensors"`
}

// captureIface is the interface a capture started from this sensor's card
// should record on, preferring what the sensor says it is reading.
//
// capture.wifi_interface is one global for what is now two Wi-Fi receivers, so
// it is wrong for at least one of them by construction: a capture started from
// the wifi-1 card recorded wlan-alfa, the other adapter, while its own card
// showed the interface as read-only "so a browser cannot silently point
// capture at another device". On a default install it is wrong for both --
// the setting ships "wlan1" and deploy/udev/70-classg-wifi.rules renames the
// adapters to wlan-alfa and wlan-tplink, so every capture from the UI failed
// preflight on an interface that does not exist.
//
// The heartbeat carries the answer. `detail` is deliberately free-form
// (schemas/heartbeat.schema.json), so this reads it as a hint and keeps the
// configured value whenever the sensor does not offer one -- a sensor kind
// that reports no iface, or a wifi sensor too old to send it, behaves exactly
// as before.
func captureIface(sensor health.Sensor, configured string) string {
	if iface, ok := sensor.Detail["iface"].(string); ok && iface != "" {
		return iface
	}
	return configured
}

func (s *Server) handleListSensors(w http.ResponseWriter, r *http.Request) {
	rep := s.Health(r.Context())
	expected := map[string]bool{}
	for _, d := range s.cfg.ExpectedSensors {
		expected[d.SensorID] = true
	}

	out := make([]sensorEntry, 0, len(rep.Sensors))
	restartAvailable, restartReason := restartAvailability(s.cfg.SensorRestartCommand)
	for _, sensor := range rep.Sensors {
		capture := captureConfig{Supported: sensor.SensorKind == "wifi"}
		if capture.Supported {
			capture.Interface = captureIface(sensor, s.cfg.WifiInterface)
			capture.Channel = s.cfg.WifiChannel
			capture.DurationS = s.cfg.CaptureDurationS
			capture.Label = s.cfg.CaptureLabel
		}
		cfg := sensorConfig{
			StaleAfterS:              int(s.cfg.SensorStaleAfter.Seconds()),
			Expected:                 expected[sensor.SensorID],
			RestartAvailable:         restartAvailable,
			RestartUnavailableReason: restartReason,
			Capture:                  capture,
		}
		if hasOwnUnit(sensor.SensorKind) {
			cfg.Unit = unitFor(sensor.SensorID, sensor.SensorKind)
			cfg.RestartCommand = restartCommandString(s.cfg.SensorRestartCommand, cfg.Unit)
		} else {
			cfg.RestartAvailable = false
			cfg.RestartUnavailableReason = sensor.SensorKind + " sources run inside fusion and have no unit of their own"
		}
		out = append(out, sensorEntry{Sensor: sensor, Config: cfg})
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
	if !hasOwnUnit(kind) {
		fail(w, apierr.SensorUnavailable(kind+" sources run inside fusion; restart fusion, not "+id))
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
	writeJSON(w, http.StatusAccepted, restartResponse{SensorID: id, Unit: unitFor(id, kind), Accepted: true})
}

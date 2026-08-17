package httpapi

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/classg/api/internal/health"
)

// Prometheus exposition, written by hand.
//
// The client library would pull in a dependency tree and a registry
// abstraction to emit a few dozen lines of text whose format is frozen by
// specification. The same trade as zmtp.rs and clock.rs: this is the whole of
// what the format requires, and it cannot rot.
//
// Everything here is derived from the same Report /health returns, so the two
// can never disagree about whether a sensor is alive.

// detailMetric maps a key inside a sensor's free-form detail blob onto a
// metric.
//
// An allowlist, deliberately, rather than exporting the blob. detail is
// whatever a sensor chose to put there, `/metrics` is the endpoint most likely
// to be scraped into somebody else's time-series database, and
// [ADR-0006](../../../../docs/architecture/adr/0006-operator-location-retention.md)
// makes the operator's position the one field that must never leave the unit
// by accident. A key that is not named below is not exported.
type detailMetric struct {
	name    string
	help    string
	counter bool
}

var sensorDetailMetrics = map[string]detailMetric{
	// Wi-Fi hopper. listening_fraction is the roadmap's "hopper efficiency":
	// the share of wall clock spent receiving rather than retuning.
	"listening_fraction": {"classg_wifi_listening_fraction", "Share of wall clock spent receiving rather than retuning.", false},
	"hops":               {"classg_wifi_hops_total", "Channel hops performed.", true},
	"escalations":        {"classg_wifi_escalations_total", "Times the hopper locked to a channel on a drone hit.", true},
	"beacons":            {"classg_wifi_beacons_total", "Beacon frames seen.", true},
	// ADS-B via dump1090.
	"messages_read": {"classg_sdr_messages_read_total", "SBS-1 messages read from dump1090.", true},
	"parsed":        {"classg_sdr_messages_parsed_total", "SBS-1 messages parsed into positions.", true},
	"unparsed":      {"classg_sdr_messages_unparsed_total", "SBS-1 messages that carried no position.", true},
	"reconnects":    {"classg_sdr_reconnects_total", "Reconnections to dump1090.", true},
	"icaos":         {"classg_sdr_icaos", "Distinct aircraft currently tracked.", false},
	"connected":     {"classg_sdr_dump1090_connected", "1 while the SBS-1 stream from dump1090 is up.", false},
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	rep := s.Health(r.Context())

	var b strings.Builder
	writeMetrics(&b, rep)

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

func writeMetrics(b *strings.Builder, rep health.Report) {
	gauge(b, "classg_build_info", "Version of the running api, as a label on a constant 1.")
	fmt.Fprintf(b, "classg_build_info{version=%s} 1\n", quote(rep.Version))

	gauge(b, "classg_uptime_seconds", "Seconds since the api process started, from the monotonic clock.")
	fmt.Fprintf(b, "classg_uptime_seconds %d\n", rep.UptimeS)

	// One series per state rather than a single number, so a dashboard can
	// alert on classg_status{status="down"} without hard-coding an encoding.
	gauge(b, "classg_status", "Overall status; 1 on the state currently reported.")
	for _, st := range []string{health.StatusOK, health.StatusDegraded, health.StatusDown} {
		fmt.Fprintf(b, "classg_status{status=%s} %d\n", quote(st), boolVal(rep.Status == st))
	}

	gauge(b, "classg_fusion_connected", "1 when the api is receiving from fusion.")
	fmt.Fprintf(b, "classg_fusion_connected %d\n", boolVal(rep.Fusion.Connected))

	gauge(b, "classg_sensor_healthy", "1 when the sensor is heartbeating and reports itself healthy.")
	for _, sn := range rep.Sensors {
		fmt.Fprintf(b, "classg_sensor_healthy%s %d\n", sensorLabels(sn), boolVal(sn.Healthy))
	}

	gauge(b, "classg_sensor_heartbeat_age_seconds", "Seconds since this api last heard from the sensor.")
	for _, sn := range rep.Sensors {
		// Absent rather than zero for a sensor that has never reported: zero
		// would read as "heard from just now", which is the opposite of true
		// and exactly the false confidence /health exists to prevent.
		if sn.SecondsSinceHeartbeat == nil {
			continue
		}
		fmt.Fprintf(b, "classg_sensor_heartbeat_age_seconds%s %d\n", sensorLabels(sn), *sn.SecondsSinceHeartbeat)
	}

	gauge(b, "classg_sensor_detections_5m", "Detections attributed to this sensor in the last five minutes.")
	for _, sn := range rep.Sensors {
		fmt.Fprintf(b, "classg_sensor_detections_5m%s %d\n", sensorLabels(sn), sn.Detections5m)
	}

	writeDetailMetrics(b, rep)
}

// writeDetailMetrics emits the allowlisted numbers out of each sensor's detail,
// grouped by metric so that HELP and TYPE appear once as the format requires.
func writeDetailMetrics(b *strings.Builder, rep health.Report) {
	keys := make([]string, 0, len(sensorDetailMetrics))
	for k := range sensorDetailMetrics {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		m := sensorDetailMetrics[key]
		var lines []string
		for _, sn := range rep.Sensors {
			v, ok := numeric(sn.Detail[key])
			if !ok {
				continue
			}
			lines = append(lines, fmt.Sprintf("%s{sensor_id=%s} %s", m.name, quote(sn.SensorID), format(v)))
		}
		if len(lines) == 0 {
			continue
		}
		kind := "gauge"
		if m.counter {
			kind = "counter"
		}
		fmt.Fprintf(b, "# HELP %s %s\n# TYPE %s %s\n", m.name, m.help, m.name, kind)
		b.WriteString(strings.Join(lines, "\n"))
		b.WriteString("\n")
	}
}

func gauge(b *strings.Builder, name, help string) {
	fmt.Fprintf(b, "# HELP %s %s\n# TYPE %s gauge\n", name, help, name)
}

func sensorLabels(sn health.Sensor) string {
	return fmt.Sprintf("{sensor_id=%s,sensor_kind=%s}", quote(sn.SensorID), quote(sn.SensorKind))
}

// numeric accepts the shapes JSON decoding produces. Booleans count: a sensor
// reporting connected=true is a perfectly good 1.
func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	default:
		return 0, false
	}
}

// format keeps integers looking like integers -- counters rendered as 1.2e+04
// are legal but unreadable in an ad-hoc curl, which is how this endpoint is
// mostly read on a unit in the field.
func format(f float64) string {
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	return fmt.Sprintf("%g", f)
}

func boolVal(b bool) int {
	if b {
		return 1
	}
	return 0
}

// quote renders a label value with the escaping the exposition format requires.
// Sensor IDs arrive from the bus, so they are not trusted to be free of the
// three characters that would otherwise break every following line.
func quote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return `"` + r.Replace(s) + `"`
}

// Package sensormetrics names the numbers inside a sensor's heartbeat detail
// that may leave this unit.
//
// It exists to be the only such list. A sensor's `detail` is a free-form blob
// -- whatever that sensor chose to publish -- and two things now read numbers
// out of it: the Prometheus exposition at /metrics, and the telemetry sampler
// that records history. Both are places where "everything in detail" would
// eventually mean an operator position in somebody else's time-series database
// (docs/research/06-legal-and-ethics.md). Two allowlists would drift, and the
// drift would be silent and in the dangerous direction, so there is one.
//
// Adding a key here is the deliberate act of publishing it.
package sensormetrics

// Metric is how one detail key is described where it surfaces.
type Metric struct {
	// Name is the Prometheus metric name.
	Name string
	Help string
	// Counter marks a monotonically increasing value, which charts as a rate
	// and exposes as a counter rather than a gauge.
	Counter bool
}

// Allowed maps a detail key to how it is published. A key absent from this map
// is not exported anywhere, by anything.
var Allowed = map[string]Metric{
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

// Numeric accepts the shapes JSON decoding produces. Booleans count: a sensor
// reporting connected=true is a perfectly good 1.
func Numeric(v any) (float64, bool) {
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

// Extract pulls every allowlisted number out of one sensor's detail blob.
func Extract(detail map[string]any) map[string]float64 {
	if len(detail) == 0 {
		return nil
	}
	out := make(map[string]float64, len(detail))
	for key := range Allowed {
		if v, ok := Numeric(detail[key]); ok {
			out[key] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

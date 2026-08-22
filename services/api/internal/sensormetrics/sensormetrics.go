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
	// The counterpart to escalations: dwells a lock handed back to the sweep.
	// Flat while escalations climb means the lock is absolute again, which is
	// the state in which a tracked drone hides every other channel.
	"scan_dwells": {"classg_wifi_scan_dwells_total", "Dwells reserved for the sweep while locked to a channel.", true},
	"beacons":     {"classg_wifi_beacons_total", "Beacon frames seen.", true},
	// Retune cost, measured per receiver rather than assumed. It was a hardcoded
	// 140 ms taken on mt7921u and applied to the rtl8852au companion too, which
	// made listening_fraction on that radio a number about the wrong hardware.
	// Exported because tuning a dwell is done against hours of this, not against
	// whatever the Sensors page happens to show right now.
	"hop_latency_ms":       {"classg_wifi_hop_latency_ms", "Measured cost of one channel retune.", false},
	"hop_latency_measured": {"classg_wifi_hop_latency_measured", "1 when hop latency is observed rather than the startup estimate.", false},

	// Channel-plan coverage. The two Wi-Fi receivers split the plan between
	// them, so which plan a radio is on decides what the unit can see at all.
	// plan_fallback is the coverage alarm: this receiver is covering the whole
	// plan alone because its companion was absent at startup.
	"plan_fallback":         {"classg_wifi_plan_fallback", "1 while this receiver widened to the full plan because its companion was absent.", false},
	"companion_present":     {"classg_wifi_companion_present", "1 while the companion receiver's interface exists.", false},
	"plan_widened_for_peer": {"classg_wifi_plan_widened_for_peer", "1 while widened to cover discovery for a peer that is busy tracking.", false},
	// Thrash detection. Climbing steadily rather than in steps means the
	// hysteresis in PlanState is too short for this site's traffic.
	"plan_swaps":       {"classg_wifi_plan_swaps_total", "Channel-plan swaps made for peer coordination.", true},
	"peers_active":     {"classg_wifi_peers_active", "1 while another receiver on this unit is contributing to a track.", false},
	"peer_tracks_seen": {"classg_wifi_peer_tracks_seen_total", "Tracks read from fusion for peer coordination.", true},

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

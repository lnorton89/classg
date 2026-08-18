package httpapi_test

import (
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

// Every field of every type, against a store that actually has rows in it.
//
// This exists because the obvious version of the schema shipped broken. Most
// types here are the schemas/ domain types and are read through their json
// tags, which works. store.SensorRecord and store.TelemetrySample are
// persistence types with no tags at all, so the default resolver matched
// nothing and returned nil for every field -- and since sensor_id is
// non-null, one untagged struct nulled the ENTIRE response.
//
// It reached the unit because the other GraphQL tests query a harness with no
// sensors and no telemetry, where `sensors` returns [] and passes. An empty
// list is not coverage. So this seeds one of everything first, and asks for
// every field the schema offers.
func TestGraphQLEveryFieldResolves(t *testing.T) {
	h := newHarness(t, map[string]string{"CLASSG_EXPOSE_OPERATOR_LOCATION": "true"})
	ctx := t.Context()

	seedTrack(t, h, "trk-cov", base, true)
	h.ingestDetection(t, sampleDetection("det-cov"))

	if err := h.store.UpsertSensor(ctx, store.SensorRecord{
		SensorID:      "wifi-0",
		SensorKind:    "wifi",
		LastHeartbeat: base,
		Healthy:       false,
		Reason:        "adapter vanished",
		Detail:        map[string]any{"channel": 6},
	}); err != nil {
		t.Fatal(err)
	}

	cpu := 51.2
	load := 0.8
	mem := int64(1_200_000)
	disk := int64(90_000_000_000)
	up := int64(86_400)
	// Inside the default window. The query defaults `since` to six hours back
	// the way the REST handler does, and `base` is a fixed date in the past.
	if err := h.store.InsertTelemetry(ctx, store.TelemetrySample{
		TS:             time.Now().UTC().Add(-time.Minute),
		CPUTempC:       &cpu,
		Load1:          &load,
		MemAvailableKB: &mem,
		DiskFreeBytes:  &disk,
		UptimeS:        &up,
		Sensors: []store.TelemetrySensor{
			{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true,
				Metrics: map[string]float64{"frames_per_s": 12}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	if err := h.store.PutCapture(ctx, model.Capture{
		CaptureID: "cap-cov",
		Filename:  "cap.pcap",
		State:     model.CaptureCompleted,
		StartedAt: base,
		EndedAt:   ptr(base.Add(time.Minute)),
		Iface:     "wlan1",
		Channel:   6,
		DurationS: 60,
		SizeBytes: 4096,
		Analysis:  &model.CaptureAnalysis{Analyzed: true, DroneTransmitters: 1},
	}); err != nil {
		t.Fatal(err)
	}

	if err := h.store.PutSweep(ctx, model.SpectrumSweep{
		SweepID: "swp-cov", Band: "ism_915", State: model.SweepCompleted,
		StartedAt: base, EndedAt: ptr(base.Add(time.Second * 20)),
		Class: "E", Note: "test", StartHz: 902_000_000, StopHz: 928_000_000, Steps: 14,
	}); err != nil {
		t.Fatal(err)
	}
	// A real document, so trace and step_peaks resolve against something the
	// sensor actually produced rather than a hand-built stub.
	bins := []byte(`{"band":"ism_915","class":"E","start_hz":902000000,"stop_hz":928000000,` +
		`"sample_rate":2400000,"fft_size":8,"dc_guard_bins":1,"gain_tenth_db":200,` +
		`"noise_floor_dbfs":-70.4,"threshold_dbfs":-60.4,"threshold_over_floor_db":10,` +
		`"steps":[{"center_hz":903000000,"first_bin_hz":901800000,"bin_width_hz":300000,` +
		`"bins_dbfs":[-70,-69,-68,-67,-66,-65,-64,-63],"peak_hz":903900000,"peak_dbfs":-63}],` +
		`"short_reads":[]}`)
	if err := h.store.PutSweepBins(ctx, "swp-cov", bins); err != nil {
		t.Fatal(err)
	}

	query := `{
      health { status uptime_s version fusion { configured connected last_message reason }
               sensors { sensor_id sensor_kind healthy last_heartbeat seconds_since_heartbeat
                         detections_5m reason optional detail } }
      system { build { version go_version revision revision_dirty built_at }
               runtime { listen store ui_dir capture_dir turso_sync_configured containerised }
               host { uptime_s load1 load5 load15 cpu_count cpu_temp_c mem_total_kb
                      mem_available_kb disk_path disk_total_bytes disk_free_bytes unavailable } }
      sensors { sensor_id sensor_kind healthy last_heartbeat reason detail }
      tracks(limit: 10) {
        total next_cursor
        tracks {
          schema_version track_id state first_seen last_seen detection_count confidence
          adsb_correlated rssi_dbm
          identity { serial macs vendor manufacturer_code model_hint operator_id ua_type }
          evidence { class sensor_kind weight count last_seen }
          current { lat lon alt_geodetic_m height_agl_m speed_mps track_deg at }
          history { lat lon at }
          operator { lat lon alt_m at }
          detections(limit: 5) { total next_cursor detections { detection_id } }
        }
      }
      detections(limit: 10) {
        total next_cursor
        detections {
          schema_version detection_id ts sensor_id sensor_kind detection_class
          rf { freq_hz channel rssi_dbm bandwidth_hz snr_db }
          identity { serial mac id_type ua_type operator_id self_id vendor_hint }
          position { lat lon at }
          kinematics { speed_mps track_deg vertical_speed_mps }
          operator { lat lon }
          signal_features { burst_rate_hz burst_duration_us duty_cycle hop_count
                            occupied_bw_hz protocol_hint }
          adsb { icao callsign alt_ft ground_speed_kt }
        }
      }
      captures { capture_id filename state started_at ended_at iface channel duration_s
                 size_bytes frame_count label error analysis { analyzed drone_transmitters class_a class_b } }
      capture(capture_id: "cap-cov") { capture_id state }
      bands { available reason running_sweep_id bands { name class note start_hz stop_hz steps } }
      sweeps(limit: 10) { sweep_id band state started_at ended_at class note start_hz stop_hz
                          steps noise_floor_dbfs threshold_dbfs peak_dbfs peak_hz short_reads error }
      sweep(sweep_id: "swp-cov") {
        sweep_id band state
        trace(bins: 16) { start_hz stop_hz bin_width_hz dbfs blind }
        step_peaks { center_hz peak_hz peak_dbfs }
      }
      telemetry(limit: 10) { ts cpu_temp_c load1 mem_available_kb disk_free_bytes uptime_s
                             sensors { sensor_id sensor_kind healthy metrics } }
    }`

	got := gql(t, h, query)
	if len(got.Errors) > 0 {
		t.Fatalf("a field in the schema did not resolve: %s", got.firstError())
	}

	// A non-null violation nulls the whole response rather than one field, so
	// `data: null` is the shape this bug actually took on the unit.
	if string(got.Data) == "null" {
		t.Fatal("data is null; something non-null resolved to nil")
	}

	// The specific values that were nil. Asserted rather than merely
	// "no errors", because an optional field that silently returns null does
	// not produce an error either.
	for _, want := range []string{
		`"sensor_id":"wifi-0"`,
		`"reason":"adapter vanished"`,
		`"cpu_temp_c":51.2`,
		`"uptime_s":"86400"`,
		`"track_id":"trk-cov"`,
		`"detection_id":"det-cov"`,
		`"capture_id":"cap-cov"`,
		`"sweep_id":"swp-cov"`,
	} {
		// The raw response, not a whitespace-stripped copy: the values here
		// contain spaces, and compacting the document would corrupt them.
		if !strings.Contains(string(got.Data), want) {
			t.Errorf("response is missing %s", want)
		}
	}
}

func ptr[T any](v T) *T { return &v }

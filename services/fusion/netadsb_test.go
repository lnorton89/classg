package fusion

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// The sample is shaped like a real /v2/point response, including the two things
// that break a naive decoder: alt_baro as the string "ground", and a callsign
// padded to eight characters.
const samplePoint = `{
  "ac": [
    {"hex":"a1b2c3","flight":"UAL123  ","alt_baro":31000,"alt_geom":31200,
     "lat":47.6762,"lon":-122.3648,"gs":432.5,"track":187.4,"seen":0.4,"seen_pos":1.1},
    {"hex":"c0ffee","flight":"","alt_baro":"ground","lat":47.6062,"lon":-122.3348,"gs":12.0,"seen_pos":0.2},
    {"hex":"","flight":"NOHEX","alt_baro":5000,"lat":47.5662,"lon":-122.2648,"seen_pos":0.1},
    {"hex":"beef01","alt_baro":2200,"lat":47.6162,"lon":-122.2748,"track":360,"seen_pos":0.5},
    {"hex":"01dead","alt_baro":8000,"lat":47.7662,"lon":-122.4648,"seen_pos":900}
  ],
  "total": 5, "now": 1754870400000
}`

func testFeed(t *testing.T, handler http.HandlerFunc) (*NetADSBFeed, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	feed, err := NewNetADSBFeed(NetADSBConfig{
		BaseURL: server.URL,
		Lat:     47.6062,
		Lon:     -122.3321,
	})
	if err != nil {
		t.Fatalf("new feed: %v", err)
	}
	return feed, server
}

func pollOnce(t *testing.T, body string) [][]byte {
	t.Helper()
	feed, _ := testFeed(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	})
	payloads, total, err := feed.Poll(context.Background())
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if total == 0 {
		t.Fatal("expected the response total to be reported")
	}
	return payloads
}

// The whole point of encoding through netDetection rather than Detection is
// that what goes on the bus is valid. Assert it against the actual contract
// rather than against our own idea of it.
func TestNetADSBEmitsSchemaValidDetections(t *testing.T) {
	source, err := os.ReadFile("../../schemas/detection.schema.json")
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(source)))
	if err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("detection.schema.json", doc); err != nil {
		t.Fatalf("add schema: %v", err)
	}
	schema, err := compiler.Compile("detection.schema.json")
	if err != nil {
		t.Fatalf("compile schema: %v", err)
	}

	payloads := pollOnce(t, samplePoint)
	if len(payloads) == 0 {
		t.Fatal("no detections emitted")
	}
	for _, body := range payloads {
		instance, err := jsonschema.UnmarshalJSON(strings.NewReader(string(body)))
		if err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		if err := schema.Validate(instance); err != nil {
			t.Errorf("payload does not satisfy detection.schema.json:\n%s\n%v", body, err)
		}
	}
}

func TestNetADSBFiltersUnusableAircraft(t *testing.T) {
	payloads := pollOnce(t, samplePoint)

	got := map[string]netDetection{}
	for _, body := range payloads {
		var d netDetection
		if err := json.Unmarshal(body, &d); err != nil {
			t.Fatalf("decode: %v", err)
		}
		got[d.ADSB.ICAO] = d
	}

	for _, icao := range []string{"A1B2C3", "BEEF01"} {
		if _, ok := got[icao]; !ok {
			t.Errorf("expected %s to be forwarded", icao)
		}
	}
	// C0FFEE is on the ground, the third entry has no ICAO address to key on,
	// and 01DEAD's fix is 15 minutes old -- older than a contact would survive.
	for _, icao := range []string{"C0FFEE", "01DEAD"} {
		if _, ok := got[icao]; ok {
			t.Errorf("expected %s to be filtered out", icao)
		}
	}
	if len(got) != 2 {
		t.Fatalf("forwarded %d aircraft, want 2: %v", len(got), got)
	}
}

func TestNetADSBNormalisesFields(t *testing.T) {
	payloads := pollOnce(t, samplePoint)
	byICAO := map[string]netDetection{}
	for _, body := range payloads {
		var d netDetection
		if err := json.Unmarshal(body, &d); err != nil {
			t.Fatalf("decode: %v", err)
		}
		byICAO[d.ADSB.ICAO] = d
	}

	airliner := byICAO["A1B2C3"]
	if airliner.ADSB.Callsign != "UAL123" {
		t.Errorf("callsign %q: upstream pads to eight characters", airliner.ADSB.Callsign)
	}
	if airliner.SensorKind != "net" {
		t.Errorf("sensor_kind %q, want net", airliner.SensorKind)
	}
	if airliner.ADSB.AltFt == nil || *airliner.ADSB.AltFt != 31000 {
		t.Errorf("alt_ft %v, want 31000", airliner.ADSB.AltFt)
	}
	// 432.5 kt in m/s.
	if airliner.Kinematics == nil || airliner.Kinematics.SpeedMPS == nil {
		t.Fatal("expected ground speed to be converted")
	}
	if got := *airliner.Kinematics.SpeedMPS; got < 222 || got > 223 {
		t.Errorf("speed_mps %.2f, want ~222.5", got)
	}

	// track_deg has an exclusive maximum of 360 in the schema, so a heading
	// reported as exactly 360 has to fold to 0 rather than pass through.
	folded := byICAO["BEEF01"]
	if folded.Kinematics == nil || folded.Kinematics.TrackDeg == nil {
		t.Fatal("expected a track angle")
	}
	if *folded.Kinematics.TrackDeg != 0 {
		t.Errorf("track_deg %v, want 360 folded to 0", *folded.Kinematics.TrackDeg)
	}
}

// A network detection has to be indistinguishable from an SDR one by the time
// it reaches correlation, or the suppression this feed exists for does not
// happen.
func TestNetADSBDetectionsReachContactStore(t *testing.T) {
	payloads := pollOnce(t, samplePoint)
	store := NewContactStore()

	for _, body := range payloads {
		d, err := ParseDetection(body)
		if err != nil {
			t.Fatalf("parse: %v\n%s", err, body)
		}
		if _, isNew := store.Observe(d); !isNew {
			t.Errorf("expected a new contact for %s", d.ADSB.ICAO)
		}
	}
	if store.Len() != 2 {
		t.Fatalf("contacts %d, want 2", store.Len())
	}

	// And it must not become a track. Class D is suppression evidence only.
	tracks := NewTrackStore(DefaultWeights(), NewTrackID)
	d, err := ParseDetection(payloads[0])
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if track := tracks.Ingest(d, time.Now().UTC()); track != nil {
		t.Fatalf("network ADS-B minted a track: %+v", track)
	}
}

func TestNetADSBPollReportsUpstreamFailure(t *testing.T) {
	feed, _ := testFeed(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	})
	if _, _, err := feed.Poll(context.Background()); err == nil {
		t.Fatal("expected an error for a 429")
	} else if !strings.Contains(err.Error(), "429") {
		t.Errorf("error %q should name the status", err)
	}
}

// A feed that dies on a dropped uplink would take the detector's radios with
// it. ADR-0003 applies here exactly as it does to a sensor.
func TestNetADSBRunDegradesRatherThanStopping(t *testing.T) {
	// The handler runs on httptest's goroutine while the test body flips this
	// from its own, so a plain bool here is a race the -race build fails on.
	var fail atomic.Bool
	fail.Store(true)
	feed, _ := testFeed(t, func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			http.Error(w, "upstream down", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(samplePoint))
	})
	feed.cfg.Interval = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	statuses := make(chan NetADSBStatus, 16)
	go feed.Run(ctx,
		func([]byte) {},
		func(s NetADSBStatus) {
			select {
			case statuses <- s:
			default:
			}
		},
	)

	first := <-statuses
	if first.Healthy || first.LastError == "" {
		t.Fatalf("first status should be an unhealthy one with a reason: %+v", first)
	}
	fail.Store(false)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case s := <-statuses:
			if s.Healthy {
				if s.Aircraft != 2 {
					t.Errorf("recovered poll forwarded %d aircraft, want 2", s.Aircraft)
				}
				return
			}
		case <-deadline:
			t.Fatal("feed never recovered after the upstream came back")
		}
	}
}

func TestNetADSBConfigRejectsUnsetPosition(t *testing.T) {
	if _, err := NewNetADSBFeed(NetADSBConfig{}); err == nil {
		t.Fatal("expected 0,0 to be rejected")
	}
	if _, err := NewNetADSBFeed(NetADSBConfig{Lat: 47.6062, Lon: -122.3348, RadiusNM: 500}); err == nil {
		t.Fatal("expected an over-range radius to be rejected")
	}
}

func TestNetADSBEndpointShape(t *testing.T) {
	feed, err := NewNetADSBFeed(NetADSBConfig{BaseURL: "https://example.test/", Lat: 47.6062, Lon: -122.3321, RadiusNM: 30})
	if err != nil {
		t.Fatalf("new feed: %v", err)
	}
	want := "https://example.test/v2/point/47.6062/-122.3321/30"
	if got := feed.endpoint(); got != want {
		t.Errorf("endpoint %q, want %q", got, want)
	}
}

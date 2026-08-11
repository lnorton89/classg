package fusion

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func terrainServer(t *testing.T, elevation string) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"OK","results":[{"elevation":%s}]}`, elevation)
	}))
	t.Cleanup(server.Close)
	return server, &calls
}

func newTestTerrain(t *testing.T, baseURL string, geoid float64) *Terrain {
	t.Helper()
	terrain := NewTerrain(TerrainConfig{BaseURL: baseURL, GeoidOffsetM: geoid, MinInterval: 0})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go terrain.Run(ctx)
	return terrain
}

// waitForElevation polls the cache, which is the only way to observe an
// asynchronous fetch landing.
func waitForElevation(t *testing.T, terrain *Terrain, lat, lon float64) float64 {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if elevation, ok := terrain.ElevationM(lat, lon); ok {
			return elevation
		}
		select {
		case <-deadline:
			t.Fatalf("no elevation for %.4f,%.4f after 2s: %+v", lat, lon, terrain.Stats())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// The contract that makes this safe to call from the ingest loop: a miss
// returns immediately rather than waiting on the network.
func TestTerrainMissDoesNotBlock(t *testing.T) {
	blocked := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-blocked
		fmt.Fprint(w, `{"status":"OK","results":[{"elevation":100}]}`)
	}))
	defer server.Close()
	defer close(blocked)

	terrain := newTestTerrain(t, server.URL, 0)

	start := time.Now()
	if _, ok := terrain.ElevationM(47.6062, -122.3321); ok {
		t.Fatal("a cold cache must miss")
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Fatalf("lookup took %v; it must not wait on the fetch", elapsed)
	}
}

func TestTerrainCachesAndAppliesGeoidOffset(t *testing.T) {
	server, calls := terrainServer(t, "123.5")
	// The Pacific Northwest sits about 22 m below the ellipsoid, so an
	// orthometric 123.5 m is 101.5 m in the datum Remote ID reports altitude in.
	terrain := newTestTerrain(t, server.URL, -22)

	if got := waitForElevation(t, terrain, 47.6062, -122.3321); got != 101.5 {
		t.Errorf("elevation %.2f, want 101.5 (123.5 corrected by -22)", got)
	}

	// A repeat lookup, and one a few metres away, both come from cache. The
	// grid is deliberately as coarse as the dataset, so a drifting GPS fix does
	// not generate a request per report. (Cells are absolute, not relative to
	// the first point seen, so a fix near a cell boundary can still miss --
	// that costs one request, not correctness.)
	if _, ok := terrain.ElevationM(47.6062, -122.3321); !ok {
		t.Error("repeat lookup missed")
	}
	if _, ok := terrain.ElevationM(47.60623, -122.33208); !ok {
		t.Error("a point a few metres away should share a grid cell")
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("%d upstream calls, want 1", n)
	}
}

func TestTerrainHeightAGL(t *testing.T) {
	server, _ := terrainServer(t, "100")
	terrain := newTestTerrain(t, server.URL, 0)
	waitForElevation(t, terrain, 47.6062, -122.3321)

	agl, ground, ok := terrain.HeightAGL(47.6062, -122.3321, 450)
	if !ok {
		t.Fatal("expected a cached elevation")
	}
	if agl != 350 || ground != 100 {
		t.Errorf("agl=%.1f ground=%.1f, want 350 and 100", agl, ground)
	}
}

// Ocean and anything past SRTM's latitude limit come back as a null elevation.
// That is an answer, not an outage, but it is not a number either.
func TestTerrainNullElevationIsNotCached(t *testing.T) {
	server, _ := terrainServer(t, "null")
	terrain := newTestTerrain(t, server.URL, 0)

	terrain.ElevationM(0.5, -140.0)
	deadline := time.After(2 * time.Second)
	for terrain.Stats().Failures == 0 {
		select {
		case <-deadline:
			t.Fatal("expected the null elevation to be recorded as a failure")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if _, ok := terrain.ElevationM(0.5, -140.0); ok {
		t.Error("a null elevation must not be cached as an elevation")
	}
	if stats := terrain.Stats(); stats.Cached != 0 || stats.LastError == "" {
		t.Errorf("stats %+v should show nothing cached and a stated reason", stats)
	}
}

func TestTerrainRecordsUpstreamFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	terrain := newTestTerrain(t, server.URL, 0)
	terrain.ElevationM(47.6062, -122.3321)

	deadline := time.After(2 * time.Second)
	for terrain.Stats().Failures == 0 {
		select {
		case <-deadline:
			t.Fatalf("expected a recorded failure: %+v", terrain.Stats())
		case <-time.After(5 * time.Millisecond):
		}
	}
	// And the cell must be re-requestable, not stuck pending forever.
	terrain.ElevationM(47.6062, -122.3321)
	for start := time.Now(); terrain.Stats().Failures < 2; {
		if time.Since(start) > 2*time.Second {
			t.Fatal("a failed cell was never retried")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// stubTerrain is a resolver that answers instantly, standing in for the real
// one in track tests.
type stubTerrain struct {
	ground float64
	ok     bool
	calls  int
}

func (s *stubTerrain) HeightAGL(_, _, alt float64) (float64, float64, bool) {
	s.calls++
	if !s.ok {
		return 0, 0, false
	}
	return alt - s.ground, s.ground, true
}

// positioned builds a Class A detection through ParseDetection rather than by
// filling the struct, so the anonymous position type stays an implementation
// detail of Detection and the test exercises the real decode path.
func positioned(t *testing.T, serial, positionJSON string) Detection {
	t.Helper()
	body := fmt.Sprintf(`{
      "schema_version":"1.0","detection_id":"01J0000000000000000000000A",
      "ts":"2026-08-11T12:00:00.000Z","sensor_id":"wifi-0","sensor_kind":"wifi",
      "detection_class":"A","identity":{"serial":%q},"position":%s}`, serial, positionJSON)
	d, err := ParseDetection([]byte(body))
	if err != nil {
		t.Fatalf("parse detection: %v", err)
	}
	return d
}

func TestTrackStoreDerivesAGLFromTerrain(t *testing.T) {
	d := positioned(t, "1596F3AAAAAAAAAAAAAA",
		`{"lat":47.6062,"lon":-122.3321,"alt_geodetic_m":450}`)

	store := NewTrackStore(DefaultWeights(), NewTrackID)
	stub := &stubTerrain{ground: 100, ok: true}
	store.UseTerrain(stub)

	track := store.Ingest(d, time.Now().UTC())
	if track == nil || track.Current == nil {
		t.Fatal("expected a track with a position")
	}
	if track.Current.HeightAGLM == nil || *track.Current.HeightAGLM != 350 {
		t.Errorf("height_agl_m %v, want 350", track.Current.HeightAGLM)
	}
	if track.Current.TerrainElevationM == nil || *track.Current.TerrainElevationM != 100 {
		t.Errorf("terrain_elevation_m %v, want 100 -- it is the provenance marker",
			track.Current.TerrainElevationM)
	}
}

func TestTrackStoreKeepsReportedAGL(t *testing.T) {
	d := positioned(t, "1596F3BBBBBBBBBBBBBB",
		`{"lat":47.6062,"lon":-122.3321,"alt_geodetic_m":450,"height_agl_m":120}`)

	store := NewTrackStore(DefaultWeights(), NewTrackID)
	stub := &stubTerrain{ground: 100, ok: true}
	store.UseTerrain(stub)

	track := store.Ingest(d, time.Now().UTC())
	if track.Current.HeightAGLM == nil || *track.Current.HeightAGLM != 120 {
		t.Errorf("height_agl_m %v: an aircraft-reported height outranks a derived one",
			track.Current.HeightAGLM)
	}
	if track.Current.TerrainElevationM != nil {
		t.Error("terrain_elevation_m must stay absent when nothing was derived")
	}
	if stub.calls != 0 {
		t.Errorf("terrain consulted %d times; it should not have been asked at all", stub.calls)
	}
}

// A cold terrain cache must leave the field absent rather than emitting a
// placeholder, and the track must still be built.
func TestTrackStoreToleratesTerrainMiss(t *testing.T) {
	d := positioned(t, "1596F3CCCCCCCCCCCCCC",
		`{"lat":47.6062,"lon":-122.3321,"alt_geodetic_m":450}`)

	store := NewTrackStore(DefaultWeights(), NewTrackID)
	store.UseTerrain(&stubTerrain{ok: false})

	track := store.Ingest(d, time.Now().UTC())
	if track == nil || track.Current == nil {
		t.Fatal("a terrain miss must not cost the track")
	}
	if track.Current.HeightAGLM != nil || track.Current.TerrainElevationM != nil {
		t.Error("a miss must leave both fields absent")
	}

	// Absent, not null. track.schema.json reads the presence of
	// terrain_elevation_m as "fusion derived this", so a null would claim a
	// derivation that never happened.
	body, err := json.Marshal(track.Current)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if jsonHasKey(body, "terrain_elevation_m") || jsonHasKey(body, "height_agl_m") {
		t.Errorf("absent fields must not be serialised: %s", body)
	}
}

func jsonHasKey(body []byte, key string) bool {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return false
	}
	_, ok := m[key]
	return ok
}

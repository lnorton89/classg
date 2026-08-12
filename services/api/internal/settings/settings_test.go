package settings

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func noEnv(string) string { return "" }

func TestRegistryIsWellFormed(t *testing.T) {
	// Guards the panic in Settings.get: every key an accessor reaches must
	// exist, and duplicate keys would silently shadow each other.
	seen := map[string]bool{}
	for _, d := range Defs {
		if seen[d.Key] {
			t.Fatalf("duplicate key %q", d.Key)
		}
		seen[d.Key] = true
		if d.Kind == "" || d.Key == "" {
			t.Fatalf("%q: incomplete definition", d.Key)
		}
		if _, err := parse(d, d.Default); err != nil {
			t.Fatalf("%s: built-in default %q does not parse: %v", d.Key, d.Default, err)
		}
	}
}

func TestPrecedence(t *testing.T) {
	seed := map[string]string{"retention.tracks": "100h"}
	db := map[string]string{"retention.tracks": "200h"}
	e := env(map[string]string{"CLASSG_RETENTION_TRACKS": "300h"})

	t.Run("env beats db and seed", func(t *testing.T) {
		s, err := Resolve(db, seed, e)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.String("retention.tracks"); got != "300h" {
			t.Fatalf("got %q, want 300h", got)
		}
		if got := s.Source("retention.tracks"); got != SourceEnv {
			t.Fatalf("source = %q, want env", got)
		}
	})

	t.Run("db beats seed", func(t *testing.T) {
		s, err := Resolve(db, seed, noEnv)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.String("retention.tracks"); got != "200h" {
			t.Fatalf("got %q, want 200h", got)
		}
		if got := s.Source("retention.tracks"); got != SourceDB {
			t.Fatalf("source = %q, want db", got)
		}
	})

	t.Run("seed beats built-in default", func(t *testing.T) {
		s, err := Resolve(nil, seed, noEnv)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.String("retention.tracks"); got != "100h" {
			t.Fatalf("got %q, want 100h", got)
		}
		if got := s.Source("retention.tracks"); got != SourceSeed {
			t.Fatalf("source = %q, want seed", got)
		}
	})

	t.Run("built-in default is the final fallback", func(t *testing.T) {
		s, err := Resolve(nil, nil, noEnv)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.Source("retention.tracks"); got != SourceDefault {
			t.Fatalf("source = %q, want default", got)
		}
	})
}

func TestEveryKeyReportsASource(t *testing.T) {
	s, err := Resolve(nil, nil, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range s.Keys() {
		if s.Source(k) == "" {
			t.Fatalf("%s has no source", k)
		}
	}
}

func TestUnknownKeyIsRejected(t *testing.T) {
	// A typo in a setting the operator believes is in effect must fail loudly
	// rather than being silently ignored.
	_, err := Resolve(nil, map[string]string{"retention.trakcs": "100h"}, noEnv)
	if err == nil {
		t.Fatal("expected an error for an unknown seed key")
	}
	if !strings.Contains(err.Error(), "unknown setting") {
		t.Fatalf("unhelpful error: %v", err)
	}
}

func TestAllProblemsReportedAtOnce(t *testing.T) {
	// Fixing configuration one restart per mistake is the experience this avoids.
	_, err := Resolve(map[string]string{
		"retention.tracks":             "not-a-duration",
		"fusion.max_history":           "not-an-int",
		"api.expose_operator_location": "maybe",
	}, nil, noEnv)
	if err == nil {
		t.Fatal("expected errors")
	}
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("wrong error type: %T", err)
	}
	if len(ve.Problems) != 3 {
		t.Fatalf("got %d problems, want 3: %v", len(ve.Problems), ve.Problems)
	}
}

func TestNegativeDurationRejected(t *testing.T) {
	_, err := Resolve(map[string]string{"retention.tracks": "-5h"}, nil, noEnv)
	if err == nil {
		t.Fatal("expected an error for a negative duration")
	}
}

func TestValidateOne(t *testing.T) {
	if err := ValidateOne("retention.tracks", "48h"); err != nil {
		t.Fatalf("valid change rejected: %v", err)
	}
	if err := ValidateOne("retention.tracks", "nope"); err == nil {
		t.Fatal("expected a parse error")
	}
	if err := ValidateOne("no.such.key", "x"); err == nil {
		t.Fatal("expected an unknown-key error")
	}
	// Immutable settings are read once at startup by something holding a socket.
	if err := ValidateOne("bus.track_endpoint", "tcp://127.0.0.1:1"); err == nil {
		t.Fatal("expected an immutability error")
	}
}

func TestSensorDecls(t *testing.T) {
	s, err := Resolve(map[string]string{"sensors.expected": "wifi-0:wifi,sdr-0:sdr"}, nil, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	got := s.SensorDecls("sensors.expected")
	if len(got) != 2 || got[0].SensorID != "wifi-0" || got[1].SensorKind != "sdr" {
		t.Fatalf("bad parse: %+v", got)
	}

	if _, err := Resolve(map[string]string{"sensors.expected": "wifi-0:laser"}, nil, noEnv); err == nil {
		t.Fatal("expected an error for an unknown sensor kind")
	}
}

func TestParseReceiverPosition(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    *ReceiverPosition
		wantErr bool
	}{
		{name: "empty means unconfigured", raw: "", want: nil},
		{name: "whitespace means unconfigured", raw: "  ", want: nil},
		{name: "valid", raw: "51.4775,-0.0014", want: &ReceiverPosition{Lat: 51.4775, Lon: -0.0014}},
		{name: "spaces around fields", raw: " 51.4775 , -0.0014 ", want: &ReceiverPosition{Lat: 51.4775, Lon: -0.0014}},
		{name: "missing longitude", raw: "51.4775", wantErr: true},
		{name: "too many fields", raw: "51.4775,-0.0014,10", wantErr: true},
		{name: "non-numeric latitude", raw: "north,-0.0014", wantErr: true},
		{name: "latitude out of range", raw: "91,0", wantErr: true},
		{name: "longitude out of range", raw: "0,181", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseReceiverPosition(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestReceiverPositionSetting(t *testing.T) {
	s, err := Resolve(map[string]string{"map.receiver_position": "51.4775,-0.0014"}, nil, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	got := s.ReceiverPosition("map.receiver_position")
	if got == nil || got.Lat != 51.4775 || got.Lon != -0.0014 {
		t.Fatalf("bad parse: %+v", got)
	}

	unset, err := Resolve(nil, nil, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if got := unset.ReceiverPosition("map.receiver_position"); got != nil {
		t.Fatalf("expected unconfigured, got %+v", got)
	}

	if _, err := Resolve(map[string]string{"map.receiver_position": "91,0"}, nil, noEnv); err == nil {
		t.Fatal("expected an error for out-of-range latitude")
	}
}

// --- seed -------------------------------------------------------------------

func writeSeed(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "defaults.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadSeedFlattensNestedKeys(t *testing.T) {
	path := writeSeed(t, `
retention:
  tracks: 720h
sensors:
  expected:
    - id: wifi-0
      kind: wifi
    - id: sdr-0
      kind: sdr
  stale_after: 45s
`)
	got, err := LoadSeed(path)
	if err != nil {
		t.Fatal(err)
	}
	if got["retention.tracks"] != "720h" {
		t.Fatalf("retention.tracks = %q", got["retention.tracks"])
	}
	if got["sensors.stale_after"] != "45s" {
		t.Fatalf("sensors.stale_after = %q", got["sensors.stale_after"])
	}
	if got["sensors.expected"] != "wifi-0:wifi,sdr-0:sdr" {
		t.Fatalf("sensors.expected = %q", got["sensors.expected"])
	}
}

func TestMissingSeedIsNotAnError(t *testing.T) {
	got, err := LoadSeed(filepath.Join(t.TempDir(), "absent.yaml"))
	if err != nil {
		t.Fatalf("a missing seed must fall back to built-in defaults: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty, got %v", got)
	}
}

func TestUnparseableSeedIsAnError(t *testing.T) {
	// An operator who wrote a seed file expects it to be in effect; silently
	// ignoring it is the invisible-source failure ADR-0007 exists to prevent.
	if _, err := LoadSeed(writeSeed(t, "retention:\n  tracks: [unclosed\n")); err == nil {
		t.Fatal("expected a parse error")
	}
}

// A seed key that matches no Def is silently inert: the file says the feature
// is configured, nothing reads it, and the only symptom is the feature not
// happening. Cheap to guard, and the guard is what keeps "add a setting" from
// meaning "add it in one of the two places".
func TestShippedSeedKeysAreAllRegistered(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "config", "defaults.yaml")
	if _, err := os.Stat(path); err != nil {
		t.Skip("shipped seed not found from this directory")
	}
	seed, err := LoadSeed(path)
	if err != nil {
		t.Fatalf("shipped seed does not load: %v", err)
	}

	known := map[string]bool{}
	for _, d := range Defs {
		known[d.Key] = true
	}
	for key := range seed {
		if !known[key] {
			t.Errorf("config/defaults.yaml sets %q, which is in no Def -- it does nothing", key)
		}
	}
}

// Every one of these is documented as off by default, in three places. A
// default that drifted to on would turn a passive detector into one that
// reaches out to a third party on first boot without anyone choosing that.
func TestExternalDataIntegrationsDefaultToOff(t *testing.T) {
	s, err := Resolve(nil, nil, noEnv)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	for _, key := range []string{"fusion.net_adsb", "fusion.terrain"} {
		if s.Bool(key) {
			t.Errorf("%s defaults to on; it must be a decision, not a default", key)
		}
	}
	if path := s.String("fusion.aircraft_db"); path != "" {
		t.Errorf("fusion.aircraft_db defaults to %q, want empty", path)
	}
	if pos := s.ReceiverPosition("map.receiver_position"); pos != nil {
		t.Errorf("map.receiver_position defaults to %v; unset must stay unset", pos)
	}
}

// A bound the consuming process knows about but the registry does not gets
// enforced at the worst possible moment. Found against the running API: a 500
// nm radius stored with HTTP 200 and "Saved", and fusion then refused to start
// on its next restart with the reason only in its own log.
func TestNumericRangeIsEnforcedAtEntry(t *testing.T) {
	radius := defByKey()["fusion.net_adsb_radius_nm"]
	if radius.Range == nil {
		t.Fatal("the radius has a hard ceiling in fusion; the registry must know it too")
	}
	for _, raw := range []string{"1", "25", "250"} {
		if _, err := parse(radius, raw); err != nil {
			t.Errorf("parse(%q): %v", raw, err)
		}
	}
	for _, raw := range []string{"0", "-5", "251", "500"} {
		if _, err := parse(radius, raw); err == nil {
			t.Errorf("parse(%q) should have been refused", raw)
		}
	}

	// The same trap in the other direction: a geoid offset entered in feet.
	geoid := defByKey()["fusion.terrain_geoid_offset_m"]
	if _, err := parse(geoid, "-22.5"); err != nil {
		t.Errorf("a real geoid offset must be accepted: %v", err)
	}
	if _, err := parse(geoid, "-72"); err != nil {
		t.Errorf("-72 m is a real undulation and must be accepted: %v", err)
	}
	if _, err := parse(geoid, "-1200"); err == nil {
		t.Error("a value far outside any real geoid should be refused")
	}
}

func TestFloatSetting(t *testing.T) {
	d := Def{Key: "fusion.terrain_geoid_offset_m", Kind: KindFloat}
	// Negative is the normal case: most of the world sits below the ellipsoid.
	for _, raw := range []string{"0", "-22", "-22.5", "100.25"} {
		if _, err := parse(d, raw); err != nil {
			t.Errorf("parse(%q): %v", raw, err)
		}
	}
	for _, raw := range []string{"", "twenty", "NaN", "Inf"} {
		if _, err := parse(d, raw); err == nil {
			t.Errorf("parse(%q) should have failed", raw)
		}
	}
}

// Zero is a spin risk for an interval and a legitimate value for a rate limit,
// so it is opt-in per definition rather than globally allowed or refused.
func TestZeroDurationOnlyWhereAllowed(t *testing.T) {
	limit := Def{Key: "fusion.terrain_min_interval", Kind: KindDuration, AllowZero: true}
	if _, err := parse(limit, "0s"); err != nil {
		t.Errorf("a rate limit must accept 0 (self-hosted): %v", err)
	}
	if _, err := parse(limit, "-1s"); err == nil {
		t.Error("negative durations are still nonsense")
	}

	interval := Def{Key: "retention.interval", Kind: KindDuration}
	if _, err := parse(interval, "0s"); err == nil {
		t.Error("a zero interval must still be refused")
	}
}

func TestShippedSeedResolves(t *testing.T) {
	// The committed config/defaults.yaml must actually work: a seed that fails
	// to resolve would break every fresh install.
	path := filepath.Join("..", "..", "..", "..", "config", "defaults.yaml")
	if _, err := os.Stat(path); err != nil {
		t.Skip("shipped seed not found from this directory")
	}
	seed, err := LoadSeed(path)
	if err != nil {
		t.Fatalf("shipped seed does not load: %v", err)
	}
	if _, err := Resolve(nil, seed, noEnv); err != nil {
		t.Fatalf("shipped seed does not resolve: %v", err)
	}
}

// --- store ------------------------------------------------------------------

type fakeStore struct{ data map[string]json.RawMessage }

func newFakeStore() *fakeStore { return &fakeStore{data: map[string]json.RawMessage{}} }

func (f *fakeStore) GetConfig(_ context.Context, key string) (json.RawMessage, error) {
	v, ok := f.data[key]
	if !ok {
		return nil, errors.New("not found")
	}
	return v, nil
}

func (f *fakeStore) PutConfig(_ context.Context, key string, value json.RawMessage) error {
	f.data[key] = value
	return nil
}

func TestSeedIfEmptyOnlyRunsOnce(t *testing.T) {
	ctx := context.Background()
	st := newFakeStore()
	seed := map[string]string{"retention.tracks": "720h"}

	seeded, err := SeedIfEmpty(ctx, st, seed)
	if err != nil || !seeded {
		t.Fatalf("first seed: seeded=%v err=%v", seeded, err)
	}

	// Editing the seed file after first run must not silently change a running
	// deployment: the database is authoritative from then on.
	seeded, err = SeedIfEmpty(ctx, st, map[string]string{"retention.tracks": "1h"})
	if err != nil || seeded {
		t.Fatalf("second seed should be a no-op: seeded=%v err=%v", seeded, err)
	}
	stored, _ := LoadFromStore(ctx, st)
	if stored["retention.tracks"] != "720h" {
		t.Fatalf("stored value was overwritten: %q", stored["retention.tracks"])
	}
}

func TestSeedIfEmptyIgnoresUnknownKeys(t *testing.T) {
	ctx := context.Background()
	st := newFakeStore()
	if _, err := SeedIfEmpty(ctx, st, map[string]string{
		"retention.tracks": "720h",
		"legacy.removed":   "x",
	}); err != nil {
		t.Fatal(err)
	}
	stored, _ := LoadFromStore(ctx, st)
	if _, ok := stored["legacy.removed"]; ok {
		t.Fatal("unknown key was persisted; it would fail Resolve on next start")
	}
}

func TestPutManyIsAllOrNothing(t *testing.T) {
	ctx := context.Background()
	st := newFakeStore()
	if err := PutOne(ctx, st, "retention.tracks", "720h"); err != nil {
		t.Fatal(err)
	}

	err := PutMany(ctx, st, map[string]string{
		"retention.detections": "48h",
		"retention.tracks":     "not-a-duration",
	})
	if err == nil {
		t.Fatal("expected validation failure")
	}
	stored, _ := LoadFromStore(ctx, st)
	if _, ok := stored["retention.detections"]; ok {
		t.Fatal("a body with one bad value must leave stored settings untouched")
	}
	if stored["retention.tracks"] != "720h" {
		t.Fatalf("existing value was disturbed: %q", stored["retention.tracks"])
	}
}

func TestCorruptStoredSettingsRefuseToStart(t *testing.T) {
	// Reverting to defaults silently would let a retention window quietly reset
	// and delete data the operator expected to keep.
	ctx := context.Background()
	st := newFakeStore()
	st.data[StoreKey] = json.RawMessage(`{"broken"`)
	if _, err := LoadFromStore(ctx, st); err == nil {
		t.Fatal("expected an error for corrupt stored settings")
	}
}

func TestParseSensorDecls(t *testing.T) {
	tests := []struct {
		name     string
		raw      string
		want     []SensorDecl
		wantErrs int
	}{
		{
			// The pre-existing two-field form must keep meaning exactly what it
			// did, or an upgrade silently makes every declared sensor optional.
			name: "two fields default to required",
			raw:  "wifi-0:wifi,ble-0:ble",
			want: []SensorDecl{
				{SensorID: "wifi-0", SensorKind: "wifi"},
				{SensorID: "ble-0", SensorKind: "ble"},
			},
		},
		{
			name: "optional and required are both explicit",
			raw:  "wifi-0:wifi:required, sdr-0:sdr:optional",
			want: []SensorDecl{
				{SensorID: "wifi-0", SensorKind: "wifi"},
				{SensorID: "sdr-0", SensorKind: "sdr", Optional: true},
			},
		},
		{name: "unknown third field", raw: "sdr-0:sdr:maybe", wantErrs: 1},
		{name: "too many fields", raw: "sdr-0:sdr:optional:extra", wantErrs: 1},
		{name: "bad kind", raw: "x-0:radar", wantErrs: 1},
		{name: "duplicate id", raw: "sdr-0:sdr,sdr-0:sdr:optional", wantErrs: 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, errs := ParseSensorDecls(tc.raw)
			if len(errs) != tc.wantErrs {
				t.Fatalf("errors: got %v want %d", errs, tc.wantErrs)
			}
			if tc.wantErrs > 0 {
				return
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("[%d]: got %+v want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

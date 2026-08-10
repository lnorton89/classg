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

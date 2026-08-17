package telemetry

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/memstore"
	"github.com/classg/api/internal/system"
)

func TestSampleRecordsHostAndSensorState(t *testing.T) {
	st := memstore.New()
	reg := health.NewRegistry(30 * time.Second)
	now := time.Now()

	reg.Heartbeat(health.Heartbeat{
		SensorID: "wifi-0", SensorKind: "wifi", Healthy: true,
		TS: now.UTC(), At: now,
		Detail: map[string]any{
			"beacons":            float64(15886),
			"listening_fraction": 0.7409,
			// Not on the allowlist, so it must not be recorded.
			"operator_lat": 51.5074,
		},
	})

	s := &Sampler{Store: st, Registry: reg, System: system.Options{DiskPath: t.TempDir()}}
	if err := s.Sample(context.Background(), now); err != nil {
		t.Fatal(err)
	}

	samples, err := st.ListTelemetry(context.Background(), store.TelemetryQuery{
		Since: now.Add(-time.Hour), Until: now.Add(time.Hour), Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Fatalf("want 1 sample, got %d", len(samples))
	}

	sensors := samples[0].Sensors
	if len(sensors) != 1 || sensors[0].SensorID != "wifi-0" || !sensors[0].Healthy {
		t.Fatalf("sensor state not recorded: %+v", sensors)
	}
	if sensors[0].Metrics["beacons"] != 15886 {
		t.Fatalf("allowlisted counter missing: %+v", sensors[0].Metrics)
	}
	// The same rule /metrics follows, enforced on the path that writes to disk
	// and keeps it for a fortnight.
	if _, leaked := sensors[0].Metrics["operator_lat"]; leaked {
		t.Fatalf("an unlisted detail key was recorded: %+v", sensors[0].Metrics)
	}
}

// A sample taken where nothing is readable is still worth storing: it records
// that the api was alive and saw nothing, which is different from no row.
func TestSampleStoresNullsRatherThanZeros(t *testing.T) {
	st := memstore.New()
	reg := health.NewRegistry(30 * time.Second)
	now := time.Now()

	// Point the reader at empty roots so every /proc and /sys read fails, and
	// at a path statfs cannot resolve.
	s := &Sampler{
		Store: st, Registry: reg,
		System: system.Options{DiskPath: filepath.Join(t.TempDir(), "definitely-absent")},
	}
	withEmptyProcSys(t, s)

	if err := s.Sample(context.Background(), now); err != nil {
		t.Fatal(err)
	}

	samples, _ := st.ListTelemetry(context.Background(), store.TelemetryQuery{
		Since: now.Add(-time.Hour), Until: now.Add(time.Hour), Limit: 10,
	})
	if len(samples) != 1 {
		t.Fatalf("want 1 sample, got %d", len(samples))
	}
	if samples[0].CPUTempC != nil {
		t.Fatalf("cpu_temp_c = %v; an unreadable figure must be null, not 0", *samples[0].CPUTempC)
	}
	if samples[0].DiskFreeBytes != nil {
		t.Fatalf("disk_free_bytes = %v; want null", *samples[0].DiskFreeBytes)
	}
}

func TestSampleIsIdempotentWithinOneTimestamp(t *testing.T) {
	st := memstore.New()
	reg := health.NewRegistry(30 * time.Second)
	now := time.Now()
	s := &Sampler{Store: st, Registry: reg, System: system.Options{DiskPath: t.TempDir()}}

	for range 3 {
		if err := s.Sample(context.Background(), now); err != nil {
			t.Fatalf("a repeated timestamp must not fail: %v", err)
		}
	}

	samples, _ := st.ListTelemetry(context.Background(), store.TelemetryQuery{
		Since: now.Add(-time.Hour), Until: now.Add(time.Hour), Limit: 10,
	})
	if len(samples) != 1 {
		t.Fatalf("want 1 stored sample, got %d", len(samples))
	}
}

// withEmptyProcSys points the system reader at directories with nothing in
// them, which is how a host that cannot answer looks from inside the api.
func withEmptyProcSys(t *testing.T, s *Sampler) {
	t.Helper()
	empty := t.TempDir()
	if _, err := os.Stat(empty); err != nil {
		t.Fatal(err)
	}
	s.System.ProcRoot = empty
	s.System.SysRoot = empty
}

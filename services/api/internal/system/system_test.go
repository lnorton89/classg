package system

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func isNil(v any) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	return rv.Kind() == reflect.Ptr && rv.IsNil()
}

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }

func sprint(v any) string { return fmt.Sprintf("%+v", v) }

// fixtures builds a fake /proc and /sys so the reader can be tested on a
// machine that is not a Pi, which includes every CI runner this will ever see.
func fixtures(t *testing.T, files map[string]string) (procRoot, sysRoot string) {
	t.Helper()
	procRoot, sysRoot = t.TempDir(), t.TempDir()
	for rel, body := range files {
		root := procRoot
		if trimmed, ok := strings.CutPrefix(rel, "sys/"); ok {
			root, rel = sysRoot, trimmed
		}
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return procRoot, sysRoot
}

func TestReadsHostFiguresFromProcAndSys(t *testing.T) {
	procRoot, sysRoot := fixtures(t, map[string]string{
		"uptime":                               "11779.15 40970.38\n",
		"loadavg":                              "0.69 1.32 1.06 2/373 28\n",
		"meminfo":                              "MemTotal:        3887868 kB\nMemFree:         2140548 kB\nMemAvailable:    3408376 kB\n",
		"sys/class/thermal/thermal_zone0/temp": "42842\n",
	})

	h := collectHost(Options{procRoot: procRoot, sysRoot: sysRoot})

	if h.UptimeS == nil || *h.UptimeS != 11779 {
		t.Fatalf("uptime_s = %v, want 11779", h.UptimeS)
	}
	if h.Load1 == nil || *h.Load1 != 0.69 {
		t.Fatalf("load1 = %v, want 0.69", h.Load1)
	}
	if h.Load15 == nil || *h.Load15 != 1.06 {
		t.Fatalf("load15 = %v, want 1.06", h.Load15)
	}
	if h.MemTotalKB == nil || *h.MemTotalKB != 3887868 {
		t.Fatalf("mem_total_kb = %v, want 3887868", h.MemTotalKB)
	}
	if h.MemAvailableKB == nil || *h.MemAvailableKB != 3408376 {
		t.Fatalf("mem_available_kb = %v", h.MemAvailableKB)
	}
	// Millidegrees, and the conversion is the whole reason this is not a raw
	// passthrough: 42842 rendered as-is is a nonsense temperature.
	if h.CPUTempC == nil || *h.CPUTempC != 42.842 {
		t.Fatalf("cpu_temp_c = %v, want 42.842", h.CPUTempC)
	}
}

// The rule this package exists to enforce. A field that could not be read must
// be null with a reason, because a zero renders as a real reading: 0 °C and an
// uptime of 0 s both look plausible and are both lies.
func TestUnreadableFiguresAreNullWithAReason(t *testing.T) {
	procRoot, sysRoot := fixtures(t, nil) // empty roots: nothing readable

	h := collectHost(Options{procRoot: procRoot, sysRoot: sysRoot})

	for name, got := range map[string]any{
		"uptime_s":         h.UptimeS,
		"load1":            h.Load1,
		"cpu_temp_c":       h.CPUTempC,
		"mem_total_kb":     h.MemTotalKB,
		"mem_available_kb": h.MemAvailableKB,
	} {
		if !isNil(got) {
			t.Fatalf("%s = %v, want nil when unreadable", name, got)
		}
	}
	for _, key := range []string{"uptime_s", "load", "memory", "cpu_temp_c"} {
		if h.Unavailable[key] == "" {
			t.Fatalf("no reason recorded for %q; got %v", key, h.Unavailable)
		}
	}
}

// Throttling is the figure an operator most wants and the one the api cannot
// have from a container. It must always be listed as unavailable: a missing
// throttle flag silently reading as "not throttled" is the exact inversion
// this project treats as worse than an outage.
func TestThrottledIsAlwaysReportedUnavailable(t *testing.T) {
	procRoot, sysRoot := fixtures(t, map[string]string{"uptime": "1 1\n"})

	h := collectHost(Options{procRoot: procRoot, sysRoot: sysRoot})

	reason := h.Unavailable["throttled"]
	if reason == "" {
		t.Fatal("throttled must always be reported as unavailable")
	}
	if !contains(reason, "vcgencmd") {
		t.Fatalf("reason %q should name vcgencmd so an operator knows where to look", reason)
	}
}

// An About panel listing configuration is a classic way to publish a token.
func TestRuntimeNeverExposesTheTursoCredentialOrURL(t *testing.T) {
	rt := collectRuntime(Options{
		Listen:   ":8081",
		Store:    "libsql",
		TursoURL: "libsql://secret-host-name.turso.io",
	})

	if !rt.TursoSyncConfigured {
		t.Fatal("a configured sync should report as configured")
	}
	// The struct has no field for either, and this asserts nobody adds one.
	blob := sprint(rt)
	for _, leak := range []string{"secret-host-name", "turso.io", "libsql://"} {
		if contains(blob, leak) {
			t.Fatalf("runtime block leaked %q: %s", leak, blob)
		}
	}
}

func TestUnconfiguredSyncReportsFalse(t *testing.T) {
	if collectRuntime(Options{TursoURL: "   "}).TursoSyncConfigured {
		t.Fatal("whitespace is not a configured sync URL")
	}
}

func TestBuildAlwaysCarriesAGoVersion(t *testing.T) {
	b := collectBuild("0.1.0")
	if b.Version != "0.1.0" {
		t.Fatalf("version = %q", b.Version)
	}
	if b.GoVersion == "" {
		t.Fatal("go_version must always be available; it comes from the runtime")
	}
}

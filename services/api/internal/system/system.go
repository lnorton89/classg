// Package system reports what this unit is and how it is doing, for the
// operator UI's About panel.
//
// Two rules shape everything here, both borrowed from the health package
// because the failure they prevent is the same one.
//
// Nothing is guessed. Every field the api cannot actually read is null with a
// reason in Unavailable, never a zero. A CPU temperature of 0 °C or an uptime
// of 0 s renders as a plausible number and is a lie; "unavailable: no
// /sys/class/thermal on this host" is the truth and is more useful.
//
// Nothing secret leaves. An About panel that lists environment variables is a
// classic way to publish a token to whoever is standing behind the operator.
// The runtime block below is an allowlist of facts that are safe to show, and
// a Turso deployment is reported as a boolean rather than as its URL — the
// hostname is not needed to answer "is sync on".
package system

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
)

// Build identifies the running binary.
type Build struct {
	Version   string `json:"version"`
	GoVersion string `json:"go_version"`
	// Revision is empty in container builds: .dockerignore excludes .git, so
	// the toolchain has no VCS to stamp. Reported as unavailable rather than
	// as an empty string pretending to be a commit.
	Revision string `json:"revision,omitempty"`
	Dirty    bool   `json:"revision_dirty,omitempty"`
	BuiltAt  string `json:"built_at,omitempty"`
}

// Runtime is the allowlist of configuration worth showing an operator.
type Runtime struct {
	Listen string `json:"listen"`
	Store  string `json:"store"`
	// "off" when nginx serves the app, which is the container layout. Worth
	// showing: a stale dist/ served by the Go binary is a documented way to
	// spend an afternoon editing a component that never reaches the browser.
	UIDir      string `json:"ui_dir"`
	CaptureDir string `json:"capture_dir"`
	// Whether sync is configured, never where to or with what credential.
	TursoSyncConfigured bool `json:"turso_sync_configured"`
	// True when the api is running in a container, which is why several host
	// figures below can be unavailable on a Pi that can read them fine itself.
	Containerised bool `json:"containerised"`
}

// Host is the Pi underneath. Every pointer is null when unreadable.
type Host struct {
	UptimeS        *int64   `json:"uptime_s"`
	Load1          *float64 `json:"load1"`
	Load5          *float64 `json:"load5"`
	Load15         *float64 `json:"load15"`
	CPUCount       int      `json:"cpu_count"`
	CPUTempC       *float64 `json:"cpu_temp_c"`
	MemTotalKB     *int64   `json:"mem_total_kb"`
	MemAvailableKB *int64   `json:"mem_available_kb"`
	DiskPath       string   `json:"disk_path"`
	DiskTotalBytes *uint64  `json:"disk_total_bytes"`
	DiskFreeBytes  *uint64  `json:"disk_free_bytes"`
	// Unavailable maps a field name to why it could not be read. Present so
	// the UI can say "not readable from a container" instead of drawing a
	// blank where a number belongs.
	Unavailable map[string]string `json:"unavailable,omitempty"`
}

type Info struct {
	Build   Build   `json:"build"`
	Runtime Runtime `json:"runtime"`
	Host    Host    `json:"host"`
}

// Options is what the caller must supply; everything else is read from the OS.
type Options struct {
	Version    string
	Listen     string
	Store      string
	UIDir      string
	CaptureDir string
	TursoURL   string
	// DiskPath is the filesystem worth reporting -- the one detections land
	// on, not the container's root.
	DiskPath string
	// procRoot and sysRoot exist so tests can point at fixtures. Empty means
	// the real /proc and /sys.
	procRoot string
	sysRoot  string
}

func Collect(opts Options) Info {
	return Info{
		Build:   collectBuild(opts.Version),
		Runtime: collectRuntime(opts),
		Host:    collectHost(opts),
	}
}

func collectBuild(version string) Build {
	b := Build{Version: version, GoVersion: runtime.Version()}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return b
	}
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			b.Revision = s.Value
		case "vcs.time":
			b.BuiltAt = s.Value
		case "vcs.modified":
			b.Dirty = s.Value == "true"
		}
	}
	return b
}

func collectRuntime(opts Options) Runtime {
	return Runtime{
		Listen:              opts.Listen,
		Store:               opts.Store,
		UIDir:               opts.UIDir,
		CaptureDir:          opts.CaptureDir,
		TursoSyncConfigured: strings.TrimSpace(opts.TursoURL) != "",
		Containerised:       containerised(opts.procRoot),
	}
}

// containerised is best-effort and only ever used to explain a missing figure,
// so a wrong answer costs a slightly worse error message and nothing else.
func containerised(procRoot string) bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	b, err := os.ReadFile(path(procRoot, "/proc", "1/cgroup"))
	return err == nil && (strings.Contains(string(b), "docker") || strings.Contains(string(b), "containerd"))
}

func collectHost(opts Options) Host {
	h := Host{
		CPUCount:    runtime.NumCPU(),
		DiskPath:    opts.DiskPath,
		Unavailable: map[string]string{},
	}

	// /proc/uptime reads the host's uptime even inside a container, which is
	// what an operator means by "how long has the Pi been up".
	if fields, err := readFields(path(opts.procRoot, "/proc", "uptime")); err == nil && len(fields) > 0 {
		if f, err := strconv.ParseFloat(fields[0], 64); err == nil {
			v := int64(f)
			h.UptimeS = &v
		}
	}
	if h.UptimeS == nil {
		h.Unavailable["uptime_s"] = "could not read /proc/uptime"
	}

	if fields, err := readFields(path(opts.procRoot, "/proc", "loadavg")); err == nil && len(fields) >= 3 {
		h.Load1 = parseFloat(fields[0])
		h.Load5 = parseFloat(fields[1])
		h.Load15 = parseFloat(fields[2])
	}
	if h.Load1 == nil {
		h.Unavailable["load"] = "could not read /proc/loadavg"
	}

	h.MemTotalKB, h.MemAvailableKB = readMeminfo(path(opts.procRoot, "/proc", "meminfo"))
	if h.MemTotalKB == nil {
		h.Unavailable["memory"] = "could not read /proc/meminfo"
	}

	// Millidegrees in thermal_zone0. Absent on anything that is not a Pi, and
	// absent in a container that was not given /sys -- both are normal, so
	// neither is an error.
	if raw, err := os.ReadFile(path(opts.sysRoot, "/sys", "class/thermal/thermal_zone0/temp")); err == nil {
		if milli, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64); err == nil {
			c := float64(milli) / 1000
			h.CPUTempC = &c
		}
	}
	if h.CPUTempC == nil {
		h.Unavailable["cpu_temp_c"] = "no readable /sys/class/thermal/thermal_zone0/temp"
	}

	if opts.DiskPath != "" {
		var st syscall.Statfs_t
		if err := syscall.Statfs(opts.DiskPath, &st); err == nil {
			total := st.Blocks * uint64(st.Bsize)
			free := st.Bavail * uint64(st.Bsize)
			h.DiskTotalBytes = &total
			h.DiskFreeBytes = &free
		} else {
			h.Unavailable["disk"] = fmt.Sprintf("statfs %s: %v", opts.DiskPath, err)
		}
	}

	// The one an operator most wants and the api cannot have. Undervoltage and
	// thermal throttling live behind vcgencmd, which needs the binary and
	// /dev/vcio; neither is in this image, and no sysfs equivalent exists on
	// this kernel. Saying so is the point -- a missing throttle flag must not
	// read as "not throttled", which is exactly the false confidence the
	// health package exists to prevent.
	h.Unavailable["throttled"] = "vcgencmd is not available to the api; run `vcgencmd get_throttled` on the Pi"

	if len(h.Unavailable) == 0 {
		h.Unavailable = nil
	}
	return h
}

func readMeminfo(p string) (total, available *int64) {
	f, err := os.Open(p)
	if err != nil {
		return nil, nil
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "MemTotal":
			n := v
			total = &n
		case "MemAvailable":
			n := v
			available = &n
		}
	}
	return total, available
}

func readFields(p string) ([]string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(b)), nil
}

func parseFloat(s string) *float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &f
}

// path joins a test root with a real absolute path, so fixtures can stand in
// for /proc and /sys without the production call sites carrying a prefix.
func path(root, real, rel string) string {
	if root == "" {
		return real + "/" + rel
	}
	return root + "/" + rel
}

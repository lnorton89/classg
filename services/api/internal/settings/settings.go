// Package settings implements Tier 2 of ADR-0007: runtime settings that live in
// the database, seeded from config/defaults.yaml, overridable by environment.
//
// The point of this package is not that values can come from several places --
// they always could. It is that every effective value carries the Source it came
// from. The bug ADR-0007 was written against was three files disagreeing about
// the default store with no way to tell which won; reporting Source is what
// makes that impossible to repeat.
//
// Resolution order, highest first:
//
//	environment  >  database  >  seed YAML  >  built-in default
package settings

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Source records where an effective value came from.
type Source string

const (
	SourceEnv     Source = "env"
	SourceDB      Source = "db"
	SourceSeed    Source = "seed"
	SourceDefault Source = "default"
)

// Kind drives parsing and validation.
type Kind string

const (
	KindString     Kind = "string"
	KindBool       Kind = "bool"
	KindInt        Kind = "int"
	KindDuration   Kind = "duration"
	KindSensorList Kind = "sensor_list"
)

// Def describes one setting.
type Def struct {
	// Key is the canonical dotted name, matching config/defaults.yaml.
	Key string
	// Env is the legacy environment variable. Setting it still works and is
	// reported as SourceEnv rather than silently winning -- see ADR-0007.
	Env  string
	Kind Kind
	// Default is the built-in fallback, used when seed, db and env are all
	// silent. Expressed as a string so every tier shares one parser.
	Default string
	// Mutable settings can be changed at runtime through the API. Immutable
	// ones are read at startup by something that cannot be re-pointed while
	// running (a bound socket, a subscribed bus connection).
	Mutable bool
	Doc     string
}

// Defs is the complete Tier 2 registry. Anything not here is either Tier 1
// (bootstrap/secrets, see config.Bootstrap) or not configurable.
var Defs = []Def{
	// --- Bus. Immutable: the subscriber connects once at startup and cannot be
	// re-pointed without tearing down the goroutine that owns the socket.
	{Key: "bus.detection_endpoint", Env: "CLASSG_DETECTION_ENDPOINT", Kind: KindString,
		Default: "tcp://127.0.0.1:5556", Doc: "where sensors publish detections and heartbeats"},
	{Key: "bus.track_endpoint", Env: "CLASSG_TRACK_ENDPOINT", Kind: KindString,
		Default: "tcp://127.0.0.1:5557", Doc: "where fusion publishes tracks"},
	{Key: "bus.detection_topic", Env: "CLASSG_DETECTION_TOPIC", Kind: KindString,
		Default: "detection.", Doc: "ZMQ topic prefix for detections"},
	{Key: "bus.track_topic", Env: "CLASSG_TRACK_TOPIC", Kind: KindString,
		Default: "track.", Doc: "ZMQ topic prefix for tracks"},
	{Key: "bus.heartbeat_topic", Env: "CLASSG_HEARTBEAT_TOPIC", Kind: KindString,
		Default: "heartbeat.", Doc: "ZMQ topic prefix for sensor heartbeats"},

	// --- Sensors
	{Key: "sensors.expected", Env: "CLASSG_EXPECTED_SENSORS", Kind: KindSensorList,
		Default: "", Mutable: true,
		Doc: "sensors that must exist; declaring them lets /health report one that never started"},
	{Key: "sensors.stale_after", Env: "CLASSG_SENSOR_STALE_AFTER", Kind: KindDuration,
		Default: "30s", Mutable: true, Doc: "heartbeat age after which a sensor is unhealthy"},
	{Key: "sensors.restart_command", Env: "CLASSG_SENSOR_RESTART_COMMAND", Kind: KindString,
		Default: "systemctl restart %s", Mutable: true, Doc: "argv template; %s is the unit name"},

	// --- Fusion
	{Key: "fusion.track_ttl", Env: "CLASSG_FUSION_TRACK_TTL", Kind: KindDuration,
		Default: "5m", Mutable: true, Doc: "age after which a track with no update is closed"},
	{Key: "fusion.max_history", Env: "CLASSG_MAX_HISTORY", Kind: KindInt,
		Default: "512", Mutable: true, Doc: "position history points retained per track"},

	// --- Retention
	{Key: "retention.detections", Env: "CLASSG_RETENTION_DETECTIONS", Kind: KindDuration,
		Default: "168h", Mutable: true, Doc: "how long raw detections are kept"},
	{Key: "retention.tracks", Env: "CLASSG_RETENTION_TRACKS", Kind: KindDuration,
		Default: "2160h", Mutable: true, Doc: "how long tracks are kept"},
	{Key: "retention.interval", Env: "CLASSG_RETENTION_INTERVAL", Kind: KindDuration,
		Default: "1h", Mutable: true, Doc: "how often the retention job runs"},

	// --- Capture
	{Key: "capture.wifi_interface", Env: "CLASSG_WIFI_INTERFACE", Kind: KindString,
		Default: "wlan1", Mutable: true, Doc: "monitor-mode interface used for captures"},
	{Key: "capture.wifi_channel", Env: "CLASSG_WIFI_CHANNEL", Kind: KindInt,
		Default: "6", Mutable: true, Doc: "default capture channel"},
	{Key: "capture.duration_s", Env: "CLASSG_CAPTURE_DURATION_S", Kind: KindInt,
		Default: "120", Mutable: true, Doc: "default capture duration in seconds"},
	{Key: "capture.label", Env: "CLASSG_CAPTURE_LABEL", Kind: KindString,
		Default: "sensor-capture", Mutable: true, Doc: "default capture label"},
	{Key: "capture.dir", Env: "CLASSG_CAPTURE_DIR", Kind: KindString,
		Default: "captures", Doc: "directory captures are written to"},
	{Key: "capture.allow_unprivileged", Env: "CLASSG_CAPTURE_ALLOW_UNPRIVILEGED", Kind: KindBool,
		Default: "false", Mutable: true, Doc: "attempt capture without elevated privileges"},
	{Key: "capture.sensor_wifi_dir", Env: "CLASSG_SENSOR_WIFI_DIR", Kind: KindString,
		Default: "../sensor-wifi", Doc: "path to the sensor-wifi checkout used for analysis"},
	{Key: "capture.python_bin", Env: "CLASSG_PYTHON", Kind: KindString,
		Default: "python3", Doc: "python interpreter used to run the analyzer"},

	// --- API
	{Key: "api.expose_operator_location", Env: "CLASSG_EXPOSE_OPERATOR_LOCATION", Kind: KindBool,
		Default: "true", Mutable: true, Doc: "include the pilot ground position in responses"},
	{Key: "api.ui_dir", Env: "CLASSG_UI_DIR", Kind: KindString,
		Default: "../ui/dist", Doc: `directory of the built web app, or "off" to serve API only`},
	{Key: "api.version", Env: "CLASSG_VERSION", Kind: KindString,
		Default: "0.1.0", Doc: "version string reported by /health"},

	// --- Monitoring. Always-on by default: a detector you have to remember to
	// arm is a detector that is off when it matters.
	{Key: "monitoring.enabled", Env: "CLASSG_MONITORING_ENABLED", Kind: KindBool,
		Default: "true", Mutable: true,
		Doc: "record detections continuously; pausing discards them at ingest, it does not stop the radio"},
}

func defByKey() map[string]Def {
	m := make(map[string]Def, len(Defs))
	for _, d := range Defs {
		m[d.Key] = d
	}
	return m
}

// Value is one resolved setting.
type Value struct {
	Key     string `json:"-"`
	Value   any    `json:"value"`
	Raw     string `json:"-"`
	Source  Source `json:"source"`
	Mutable bool   `json:"mutable"`
	Doc     string `json:"doc,omitempty"`
}

// Settings is the resolved Tier 2 set.
type Settings struct {
	values map[string]Value
}

// Keys returns every key, sorted, so output is deterministic.
func (s *Settings) Keys() []string {
	out := make([]string, 0, len(s.values))
	for k := range s.values {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// All returns the resolved set for GET /config/settings.
func (s *Settings) All() map[string]Value {
	out := make(map[string]Value, len(s.values))
	for k, v := range s.values {
		out[k] = v
	}
	return out
}

func (s *Settings) get(key string) Value {
	v, ok := s.values[key]
	if !ok {
		// A typo in a key name is a programming error, not operator input, and
		// silently returning a zero value would produce a service configured
		// with nothing. Panicking here is caught by the registry test.
		panic("settings: unknown key " + key)
	}
	return v
}

func (s *Settings) String(key string) string { return s.get(key).Raw }

func (s *Settings) Bool(key string) bool {
	b, _ := strconv.ParseBool(s.get(key).Raw)
	return b
}

func (s *Settings) Int(key string) int {
	n, _ := strconv.Atoi(s.get(key).Raw)
	return n
}

func (s *Settings) Duration(key string) time.Duration {
	d, _ := time.ParseDuration(s.get(key).Raw)
	return d
}

// SensorDecl is an expected sensor.
type SensorDecl struct {
	SensorID   string `json:"sensor_id"`
	SensorKind string `json:"sensor_kind"`
}

func (s *Settings) SensorDecls(key string) []SensorDecl {
	decls, _ := ParseSensorDecls(s.get(key).Raw)
	return decls
}

// Source reports where a key's effective value came from.
func (s *Settings) Source(key string) Source { return s.get(key).Source }

// Resolve combines the tiers. db and seed are flat key->raw-string maps;
// getenv is os.Getenv in production.
//
// Every validation problem is collected rather than returned one at a time: an
// operator fixing configuration one restart per mistake is the experience this
// avoids.
func Resolve(db, seed map[string]string, getenv func(string) string) (*Settings, error) {
	var problems []string
	values := make(map[string]Value, len(Defs))

	for _, d := range Defs {
		raw, src := d.Default, SourceDefault
		if v, ok := seed[d.Key]; ok && strings.TrimSpace(v) != "" {
			raw, src = v, SourceSeed
		}
		if v, ok := db[d.Key]; ok && strings.TrimSpace(v) != "" {
			raw, src = v, SourceDB
		}
		if d.Env != "" {
			if v := strings.TrimSpace(getenv(d.Env)); v != "" {
				raw, src = v, SourceEnv
			}
		}

		typed, err := parse(d, raw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s (%s): %v", d.Key, src, err))
			continue
		}
		values[d.Key] = Value{
			Key: d.Key, Value: typed, Raw: raw,
			Source: src, Mutable: d.Mutable, Doc: d.Doc,
		}
	}

	// An unknown key in the seed or database is almost always a typo in a
	// setting the operator believes is in effect. Failing loudly beats silently
	// ignoring it -- that is the same class of bug as the disagreeing store
	// defaults this package exists to prevent.
	known := defByKey()
	for _, m := range []struct {
		src  string
		vals map[string]string
	}{{"seed", seed}, {"database", db}} {
		var unknown []string
		for k := range m.vals {
			if _, ok := known[k]; !ok {
				unknown = append(unknown, k)
			}
		}
		sort.Strings(unknown)
		for _, k := range unknown {
			problems = append(problems, fmt.Sprintf("%s: unknown setting %q", m.src, k))
		}
	}

	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, &ValidationError{Problems: problems}
	}
	return &Settings{values: values}, nil
}

// ValidateOne checks a single key/value pair for the runtime PUT path.
func ValidateOne(key, raw string) error {
	d, ok := defByKey()[key]
	if !ok {
		return fmt.Errorf("unknown setting %q", key)
	}
	if !d.Mutable {
		return fmt.Errorf("%q is not changeable at runtime; it is read once at startup", key)
	}
	_, err := parse(d, raw)
	return err
}

func parse(d Def, raw string) (any, error) {
	switch d.Kind {
	case KindString:
		return raw, nil
	case KindBool:
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, fmt.Errorf("%q is not a boolean (use true or false)", raw)
		}
		return v, nil
	case KindInt:
		v, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("%q is not an integer", raw)
		}
		return v, nil
	case KindDuration:
		v, err := time.ParseDuration(raw)
		if err != nil {
			return nil, fmt.Errorf("%q is not a duration (e.g. 30s, 24h)", raw)
		}
		if v <= 0 {
			return nil, fmt.Errorf("must be positive, got %s", v)
		}
		return v.String(), nil
	case KindSensorList:
		decls, errs := ParseSensorDecls(raw)
		if len(errs) > 0 {
			return nil, fmt.Errorf("%s", strings.Join(errs, "; "))
		}
		return decls, nil
	default:
		return nil, fmt.Errorf("unhandled kind %q", d.Kind)
	}
}

// ParseSensorDecls reads "wifi-0:wifi,sdr-0:sdr".
func ParseSensorDecls(raw string) ([]SensorDecl, []string) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var (
		out  []SensorDecl
		errs []string
		seen = map[string]bool{}
	)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, kind, ok := strings.Cut(part, ":")
		id, kind = strings.TrimSpace(id), strings.TrimSpace(kind)
		if !ok || id == "" || kind == "" {
			errs = append(errs, fmt.Sprintf("%q is not sensor_id:sensor_kind", part))
			continue
		}
		switch kind {
		case "wifi", "sdr", "ble":
		default:
			errs = append(errs, fmt.Sprintf("%q: sensor_kind must be wifi, sdr or ble", part))
			continue
		}
		if seen[id] {
			errs = append(errs, fmt.Sprintf("%q: duplicate sensor_id", id))
			continue
		}
		seen[id] = true
		out = append(out, SensorDecl{SensorID: id, SensorKind: kind})
	}
	return out, errs
}

// ValidationError renders as an operator-readable list.
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	var b strings.Builder
	b.WriteString("invalid settings:")
	for _, p := range e.Problems {
		b.WriteString("\n  - ")
		b.WriteString(p)
	}
	return b.String()
}

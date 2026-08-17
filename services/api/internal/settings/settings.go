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
	"math"
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
	KindFloat      Kind = "float"
	KindDuration   Kind = "duration"
	KindSensorList Kind = "sensor_list"
	KindLatLon     Kind = "lat_lon"
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
	// AllowZero permits a zero duration. Off by default because a zero
	// interval is almost always a mistake that turns a timer into a spin, but
	// a rate limit is the exception: zero legitimately means "do not throttle",
	// which is what a self-hosted terrain service wants.
	AllowZero bool
	// Range bounds a KindInt or KindFloat. Nil means unconstrained.
	Range *Range
	Doc   string
}

// Range is the accepted interval for a numeric setting, inclusive.
//
// Worth having rather than leaving the limit to whichever process consumes the
// value: without it a bound that only the consumer knows about is enforced far
// too late. A radius above the aggregator's maximum stored happily, reported
// "Saved", and then made fusion refuse to start on its next restart -- so the
// operator got a success message and a detector that did not come back, with
// the reason visible only in a log they had no reason to open.
type Range struct{ Min, Max float64 }

func (r Range) contains(v float64) bool { return v >= r.Min && v <= r.Max }

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
		Doc: "sensors that must exist, as id:kind[:optional]; declaring them lets /health report one that never started"},
	{Key: "sensors.stale_after", Env: "CLASSG_SENSOR_STALE_AFTER", Kind: KindDuration,
		Default: "30s", Mutable: true, Doc: "heartbeat age after which a sensor is unhealthy"},
	{Key: "sensors.restart_command", Env: "CLASSG_SENSOR_RESTART_COMMAND", Kind: KindString,
		Default: "systemctl restart %s", Mutable: true, Doc: "argv template; %s is the unit name"},
	{Key: "sensors.oui_registry", Env: "CLASSG_WIFI_OUI_REGISTRY", Kind: KindString,
		Default: "data/ieee-oui.csv", Mutable: true,
		Doc: "IEEE oui.csv used to expand vendor OUI patterns for Class C; skipped when the file is absent"},

	// --- Fusion
	{Key: "fusion.track_ttl", Env: "CLASSG_FUSION_TRACK_TTL", Kind: KindDuration,
		Default: "5m", Mutable: true, Doc: "age after which a track with no update is closed"},
	{Key: "fusion.max_history", Env: "CLASSG_MAX_HISTORY", Kind: KindInt,
		Default: "512", Mutable: true, Doc: "position history points retained per track"},

	// --- Fusion: optional external data (docs/ops/07-external-data.md).
	//
	// Registered here so they are seeded, reported with a source, and editable
	// like every other Tier 2 value. One caveat that applies to every fusion
	// setting, not just these: fusion reads the environment, not the database,
	// so a value stored through PUT reaches the API's view of the world and not
	// fusion's until the env is set and fusion restarts. That seam predates
	// these keys -- fusion.track_ttl has it too -- and is why the defaults here
	// deliberately match the built-in defaults in the fusion package.
	{Key: "fusion.net_adsb", Env: "CLASSG_FUSION_NET_ADSB", Kind: KindBool,
		Default: "false", Mutable: true,
		Doc: "poll a network ADS-B aggregator for manned traffic; off means Class D comes from the SDR alone"},
	{Key: "fusion.net_adsb_url", Env: "CLASSG_FUSION_NET_ADSB_URL", Kind: KindString,
		Default: "https://api.adsb.lol", Mutable: true,
		Doc: "base URL of a /v2/point aggregator (adsb.lol, adsb.fi, airplanes.live)"},
	// 250 is the aggregator's own ceiling, and fusion refuses to start above
	// it. Stated here so the refusal happens at the point of entry rather than
	// at the next restart.
	{Key: "fusion.net_adsb_radius_nm", Env: "CLASSG_FUSION_NET_ADSB_RADIUS_NM", Kind: KindInt,
		Default: "25", Mutable: true, Range: &Range{Min: 1, Max: 250},
		Doc: "query radius in nautical miles, 250 maximum; larger means more aircraft stored and drawn"},
	{Key: "fusion.net_adsb_interval", Env: "CLASSG_FUSION_NET_ADSB_INTERVAL", Kind: KindDuration,
		Default: "10s", Mutable: true,
		Doc: "how often to poll; faster than the 60s contact window buys nothing but load"},
	{Key: "fusion.net_adsb_sensor_id", Env: "CLASSG_FUSION_NET_ADSB_SENSOR_ID", Kind: KindString,
		Default: "net-adsb-0", Mutable: true,
		Doc: "sensor id the feed heartbeats under; declare it in sensors.expected to see it on /health before its first poll"},
	{Key: "fusion.terrain", Env: "CLASSG_FUSION_TERRAIN", Kind: KindBool,
		Default: "false", Mutable: true,
		Doc: "derive height_agl_m by subtracting terrain elevation from geodetic altitude"},
	{Key: "fusion.terrain_url", Env: "CLASSG_FUSION_TERRAIN_URL", Kind: KindString,
		Default: "https://api.opentopodata.org", Mutable: true,
		Doc: "OpenTopoData base URL; point at a local instance to work with no uplink"},
	{Key: "fusion.terrain_dataset", Env: "CLASSG_FUSION_TERRAIN_DATASET", Kind: KindString,
		Default: "srtm30m", Mutable: true, Doc: "elevation dataset the instance serves"},
	{Key: "fusion.terrain_min_interval", Env: "CLASSG_FUSION_TERRAIN_MIN_INTERVAL", Kind: KindDuration,
		Default: "1s", Mutable: true, AllowZero: true,
		Doc: "rate limit on elevation lookups; 0 disables it, which is what a self-hosted instance wants"},
	// The geoid ranges roughly -106 m (Indian Ocean) to +85 m (Iceland), so
	// anything outside +/-150 is a units mistake -- feet entered as metres, or
	// an altitude pasted into the wrong field.
	{Key: "fusion.terrain_geoid_offset_m", Env: "CLASSG_FUSION_TERRAIN_GEOID_OFFSET_M", Kind: KindFloat,
		Default: "0", Mutable: true, Range: &Range{Min: -150, Max: 150},
		Doc: "local geoid undulation in metres. NOT optional in practice: elevation datasets are " +
			"orthometric and Remote ID altitude is above the WGS-84 ellipsoid, so leaving this 0 " +
			"does not skip a correction, it applies a wrong one -- about -22 m around Seattle"},
	{Key: "fusion.aircraft_db", Env: "CLASSG_FUSION_AIRCRAFT_DB", Kind: KindString,
		Default: "", Mutable: true,
		Doc: "path to an OpenSky aircraft database CSV; names ADS-B contacts. Empty means hex addresses only"},

	// --- Retention
	{Key: "retention.detections", Env: "CLASSG_RETENTION_DETECTIONS", Kind: KindDuration,
		Default: "168h", Mutable: true, Doc: "how long raw detections are kept"},
	{Key: "retention.tracks", Env: "CLASSG_RETENTION_TRACKS", Kind: KindDuration,
		Default: "2160h", Mutable: true, Doc: "how long tracks are kept"},
	{Key: "retention.telemetry", Env: "CLASSG_RETENTION_TELEMETRY", Kind: KindDuration,
		Default: "336h", Mutable: true, Doc: "how long recorded host and sensor telemetry is kept"},
	{Key: "retention.sweeps", Env: "CLASSG_RETENTION_SWEEPS", Kind: KindDuration,
		Default: "720h", Mutable: true,
		Doc: "how long stored spectrum sweeps are kept. Shorter than tracks despite being " +
			"rarer: one sweep of fpv_1g2 is about a megabyte of bins, so a few hundred of " +
			"them is a noticeable fraction of a Pi's card"},
	{Key: "retention.interval", Env: "CLASSG_RETENTION_INTERVAL", Kind: KindDuration,
		Default: "1h", Mutable: true, Doc: "how often the retention job runs"},

	// --- Telemetry
	{Key: "telemetry.interval", Env: "CLASSG_TELEMETRY_INTERVAL", Kind: KindDuration,
		Default: "1m", Mutable: true, Doc: "how often a host and sensor sample is recorded"},

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

	// --- Spectrum
	//
	// Empty by default, and that is the right default: on a unit with no SDR --
	// or with the sensor built without the `rtlsdr` feature, which is how it
	// builds everywhere except a Pi -- sweeping is simply unavailable, and the
	// band picker says so rather than the API failing to start.
	{Key: "spectrum.sdr_bin", Env: "CLASSG_SDR_BIN", Kind: KindString,
		Default: "", Doc: "path to the classg-sensor-sdr binary used for band sweeps; " +
			"empty disables sweeping"},
	{Key: "spectrum.sweep_timeout", Env: "CLASSG_SWEEP_TIMEOUT", Kind: KindDuration,
		Default: "10m", Mutable: true,
		Doc: "how long one band sweep may take before it is abandoned. fpv_1g2 is 146 tune " +
			"steps, so this is minutes -- but it is bounded, because a wedged USB device " +
			"blocks a read forever rather than failing"},

	// --- Map
	{Key: "map.receiver_position", Env: "CLASSG_RECEIVER_POSITION", Kind: KindLatLon,
		Default: "", Mutable: true,
		Doc: "lat,lon of the receiver in decimal degrees; centres the map before any track " +
			"exists to derive a position from. Empty means unconfigured -- the UI falls back to " +
			"the browser's own location where it can ask for it, or a world view"},

	// --- API
	{Key: "api.expose_operator_location", Env: "CLASSG_EXPOSE_OPERATOR_LOCATION", Kind: KindBool,
		Default: "true", Mutable: true, Doc: "include the pilot ground position in responses"},
	{Key: "api.ui_dir", Env: "CLASSG_UI_DIR", Kind: KindString,
		Default: "../ui/dist", Doc: `directory of the built web app, or "off" to serve API only`},
	{Key: "api.version", Env: "CLASSG_VERSION", Kind: KindString,
		Default: "0.1.0", Doc: "version string reported by /health"},

	// --- Monitoring. Always-on: a detector you have to remember to arm is a
	// detector that is off when it matters. Startup forces this to true and
	// does not read the stored value, so this reflects the live state rather
	// than controlling it -- if the stack is up, it is recording. Pausing lasts
	// as long as the process does.
	{Key: "monitoring.enabled", Env: "CLASSG_MONITORING_ENABLED", Kind: KindBool,
		Default: "true", Mutable: true,
		Doc: "reports whether detections are being recorded; pausing discards them at ingest, it does not stop the radio, and a restart resumes"},
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
	// Optional marks a sensor whose absence is a supported build rather than a
	// fault -- an SDR or BLE dongle that this unit may simply not have fitted.
	// It changes only what "never reported at all" means. Once an optional
	// sensor has heartbeated it is held to the same standard as any other,
	// because a radio that worked and then stopped is precisely the failure
	// ADR-0003 exists to surface.
	Optional bool `json:"optional,omitempty"`
}

func (s *Settings) SensorDecls(key string) []SensorDecl {
	decls, _ := ParseSensorDecls(s.get(key).Raw)
	return decls
}

// ReceiverPosition is a fixed ground position for the receiver -- what the map
// centres on before any track exists to derive a position from.
type ReceiverPosition struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// ReceiverPosition returns the parsed position, or nil if unconfigured.
func (s *Settings) ReceiverPosition(key string) *ReceiverPosition {
	pos, _ := ParseReceiverPosition(s.get(key).Raw)
	return pos
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
		if d.Range != nil && !d.Range.contains(float64(v)) {
			return nil, fmt.Errorf("must be between %g and %g, got %d", d.Range.Min, d.Range.Max, v)
		}
		return v, nil
	case KindFloat:
		v, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return nil, fmt.Errorf("%q is not a number", raw)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("%q is not a finite number", raw)
		}
		if d.Range != nil && !d.Range.contains(v) {
			return nil, fmt.Errorf("must be between %g and %g, got %g", d.Range.Min, d.Range.Max, v)
		}
		return v, nil
	case KindDuration:
		v, err := time.ParseDuration(raw)
		if err != nil {
			return nil, fmt.Errorf("%q is not a duration (e.g. 30s, 24h)", raw)
		}
		if v < 0 || (v == 0 && !d.AllowZero) {
			return nil, fmt.Errorf("must be positive, got %s", v)
		}
		return v.String(), nil
	case KindSensorList:
		decls, errs := ParseSensorDecls(raw)
		if len(errs) > 0 {
			return nil, fmt.Errorf("%s", strings.Join(errs, "; "))
		}
		return decls, nil
	case KindLatLon:
		return ParseReceiverPosition(raw)
	default:
		return nil, fmt.Errorf("unhandled kind %q", d.Kind)
	}
}

// ParseSensorDecls reads "wifi-0:wifi,sdr-0:sdr:optional".
//
// The third field is how a unit declares hardware it may not have fitted. It
// defaults to required, so an existing declaration keeps its current meaning.
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
		fields := strings.Split(part, ":")
		for i := range fields {
			fields[i] = strings.TrimSpace(fields[i])
		}
		if len(fields) < 2 || len(fields) > 3 || fields[0] == "" || fields[1] == "" {
			errs = append(errs, fmt.Sprintf("%q is not sensor_id:sensor_kind[:optional]", part))
			continue
		}
		id, kind := fields[0], fields[1]
		switch kind {
		case "wifi", "sdr", "ble":
		default:
			errs = append(errs, fmt.Sprintf("%q: sensor_kind must be wifi, sdr or ble", part))
			continue
		}
		var optional bool
		if len(fields) == 3 {
			switch fields[2] {
			case "optional":
				optional = true
			case "required":
				optional = false
			default:
				// Rejected rather than assumed: silently treating a typo as
				// required would leave a Pi with no SDR permanently degraded,
				// and treating it as optional would hide a dead radio.
				errs = append(errs, fmt.Sprintf("%q: third field must be optional or required", part))
				continue
			}
		}
		if seen[id] {
			errs = append(errs, fmt.Sprintf("%q: duplicate sensor_id", id))
			continue
		}
		seen[id] = true
		out = append(out, SensorDecl{SensorID: id, SensorKind: kind, Optional: optional})
	}
	return out, errs
}

// ParseReceiverPosition reads "lat,lon" in decimal degrees. An empty string is
// valid and means unconfigured -- there is no separate sentinel for "off" on
// top of blank, the same choice KindSensorList makes.
func ParseReceiverPosition(raw string) (*ReceiverPosition, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) != 2 {
		return nil, fmt.Errorf("%q is not lat,lon", raw)
	}
	lat, err := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	if err != nil {
		return nil, fmt.Errorf("%q: latitude is not a number", raw)
	}
	lon, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err != nil {
		return nil, fmt.Errorf("%q: longitude is not a number", raw)
	}
	if lat < -90 || lat > 90 {
		return nil, fmt.Errorf("latitude %v out of range (-90 to 90)", lat)
	}
	if lon < -180 || lon > 180 {
		return nil, fmt.Errorf("longitude %v out of range (-180 to 180)", lon)
	}
	return &ReceiverPosition{Lat: lat, Lon: lon}, nil
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

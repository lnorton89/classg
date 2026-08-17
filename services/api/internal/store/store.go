// Package store defines the persistence boundary for the api service.
//
// The interface exists so the database choice stays swappable and so the HTTP
// and CLI test suites do not drag in a CGO toolchain: memstore is pure Go, and
// the libSQL implementation is only compiled where its native libraries exist.
//
// Storage is a single libSQL database. Operator ground positions are stored
// inline on the track and detection documents and age out with them, so there
// is one retention policy rather than a per-field one.
package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/classg/api/internal/model"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrBadCursor = errors.New("malformed cursor")
)

// MaxLimit is the contract's ceiling on page size.
const MaxLimit = 1000

// DefaultLimit is the contract's default page size.
const DefaultLimit = 100

// Cursor is an opaque position in a (timestamp DESC, id DESC) ordering.
//
// Keyset rather than offset paging: detections arrive continuously, and an
// OFFSET page walk over a table that is being appended to silently skips rows.
type Cursor struct {
	TS time.Time
	ID string
}

func (c Cursor) Encode() string {
	raw := c.TS.UTC().Format(time.RFC3339Nano) + "\x00" + c.ID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func DecodeCursor(s string) (Cursor, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return Cursor{}, ErrBadCursor
	}
	ts, id, ok := strings.Cut(string(b), "\x00")
	if !ok {
		return Cursor{}, ErrBadCursor
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return Cursor{}, ErrBadCursor
	}
	return Cursor{TS: t.UTC(), ID: id}, nil
}

// Before reports whether (ts,id) sorts strictly after c in the descending
// ordering, i.e. whether the row belongs on a later page.
func (c Cursor) Before(ts time.Time, id string) bool {
	if ts.After(c.TS) {
		return false
	}
	if ts.Before(c.TS) {
		return true
	}
	return id < c.ID
}

type TrackQuery struct {
	States        []string
	Since         time.Time
	MinConfidence float64
	Limit         int
	Cursor        *Cursor
}

type TrackPage struct {
	Tracks     []model.Track
	NextCursor string
	Total      int
}

type DetectionQuery struct {
	Classes  []string
	SensorID string
	Since    time.Time
	Limit    int
	Cursor   *Cursor
}

// TrackDetectionQuery reconstructs the detections that fed a track.
//
// This is a reconstruction, not a recorded fact: fusion publishes tracks and
// sensors publish detections, and nothing on the bus carries the association
// between them. Matching on the track's identity within its lifetime is the
// closest honest answer available without fusion emitting the link. Flagged in
// docs/architecture/api-implementation.md.
type TrackDetectionQuery struct {
	Serial string
	MACs   []string
	From   time.Time
	To     time.Time
	Limit  int
	Cursor *Cursor
}

type DetectionPage struct {
	Detections []model.Detection
	NextCursor string
	Total      int
}

type SensorRecord struct {
	SensorID      string
	SensorKind    string
	LastHeartbeat time.Time
	Healthy       bool
	Reason        string
	Detail        map[string]any
}

// TelemetrySample is one moment of host and sensor state, recorded on a timer.
//
// Every host reading is a pointer because every one of them can be unreadable,
// and a nil must survive all the way to the chart. Storing 0 for "could not
// read the CPU temperature" would plot a cold Pi rather than a gap, which is
// the same lie /system exists to refuse.
type TelemetrySample struct {
	TS             time.Time
	CPUTempC       *float64
	Load1          *float64
	MemAvailableKB *int64
	DiskFreeBytes  *int64
	UptimeS        *int64
	Sensors        []TelemetrySensor
}

// TelemetrySensor is one sensor's state at that moment. Metrics carries only
// the keys named in internal/sensormetrics.
type TelemetrySensor struct {
	SensorID   string             `json:"sensor_id"`
	SensorKind string             `json:"sensor_kind"`
	Healthy    bool               `json:"healthy"`
	Metrics    map[string]float64 `json:"metrics,omitempty"`
}

// TelemetryQuery bounds a read. Since and Until are inclusive.
type TelemetryQuery struct {
	Since time.Time
	Until time.Time
	Limit int
}

// Store is everything the API needs from persistence.
type Store interface {
	UpsertTrack(ctx context.Context, t model.Track) error
	GetTrack(ctx context.Context, trackID string) (model.Track, error)
	ListTracks(ctx context.Context, q TrackQuery) (TrackPage, error)

	InsertDetection(ctx context.Context, d model.Detection) error
	ListDetections(ctx context.Context, q DetectionQuery) (DetectionPage, error)
	ListTrackDetections(ctx context.Context, q TrackDetectionQuery) (DetectionPage, error)

	// DetectionCountsSince powers /health's detections_5m.
	DetectionCountsSince(ctx context.Context, since time.Time) (map[string]int, error)

	UpsertSensor(ctx context.Context, s SensorRecord) error
	ListSensors(ctx context.Context) ([]SensorRecord, error)

	PutCapture(ctx context.Context, c model.Capture) error
	GetCapture(ctx context.Context, id string) (model.Capture, error)
	ListCaptures(ctx context.Context) ([]model.Capture, error)
	PutCaptureReport(ctx context.Context, id string, report json.RawMessage, summary model.CaptureAnalysis) error
	GetCaptureReport(ctx context.Context, id string) (json.RawMessage, error)

	GetConfig(ctx context.Context, key string) (json.RawMessage, error)
	PutConfig(ctx context.Context, key string, value json.RawMessage) error

	InsertTelemetry(ctx context.Context, s TelemetrySample) error
	ListTelemetry(ctx context.Context, q TelemetryQuery) ([]TelemetrySample, error)

	PurgeDetections(ctx context.Context, before time.Time) (int64, error)
	PurgeTracks(ctx context.Context, before time.Time) (int64, error)
	PurgeTelemetry(ctx context.Context, before time.Time) (int64, error)

	Close() error
}

// NormaliseLimit applies the contract's paging bounds. The messages are the
// ones the contract prints as its worked example, so a client author matching
// on them is not surprised.
func NormaliseLimit(limit int, provided bool) (int, error) {
	if !provided {
		return DefaultLimit, nil
	}
	if limit < 1 {
		return 0, fmt.Errorf("limit must be >= 1")
	}
	if limit > MaxLimit {
		return 0, fmt.Errorf("limit must be <= %d", MaxLimit)
	}
	return limit, nil
}

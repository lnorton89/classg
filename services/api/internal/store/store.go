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

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/hooks"
	"github.com/classg/api/internal/model"
)

var (
	// ErrNotFound wraps auth.ErrNotFound so the auth service -- which declares
	// its own Store interface to stay free of this package -- can recognise a
	// miss with errors.Is without either package importing the other's error.
	ErrNotFound  = fmt.Errorf("%w", auth.ErrNotFound)
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
	// LastSeenBefore keeps only tracks whose last_seen is strictly older.
	// Exists for the stale-track sweep, so staleness is decided in SQL on the
	// indexed column rather than by fetching and JSON-decoding every open
	// track. Zero means no bound.
	LastSeenBefore time.Time
	// SkipTotal skips the COUNT query and leaves Total zero. For callers that
	// iterate rather than paginate: the count is its own statement on the one
	// shared connection, and a sweep that runs on a timer has no use for it.
	SkipTotal bool
	Limit     int
	Cursor    *Cursor
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
	// SkipTotal skips the COUNT query and leaves Total zero. GraphQL runs this
	// query once per parent track; a client that did not select `total` should
	// not pay a count per track for a number nobody asked for.
	SkipTotal bool
	Limit     int
	Cursor    *Cursor
}

type DetectionPage struct {
	Detections []model.Detection
	NextCursor string
	Total      int
}

// TrackDetectionWindow is the span a track's detections are looked for in.
//
// One definition, used by the detection reconstruction and by the peak-RSSI
// backfill below, so the two cannot disagree about which detections belong to
// a track -- a list showing a peak drawn from a wider span than the detail
// page lists is the same self-contradiction the backfill exists to remove.
func TrackDetectionWindow(t model.Track) (from, to time.Time) {
	// A second of grace on the upper bound: a detection can be written by the
	// sensor path microseconds after the track update it produced, and
	// excluding it would make the last detection of every track invisible.
	return t.FirstSeen, t.LastSeen.Add(time.Second)
}

// NeedsPeakRSSI reports whether a track's rssi_dbm can and should be
// reconstructed from its detections. See Store.BackfillPeakRSSI.
//
// A track with neither a serial nor a MAC has nothing to match detections on,
// so there is no query worth running for it.
func NeedsPeakRSSI(t model.Track) bool {
	return t.RSSIdBm == nil && (t.Identity.Serial != "" || len(t.Identity.MACs) > 0)
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

	// BackfillPeakRSSI fills rssi_dbm, in place, on the given tracks that were
	// stored without one, from the peak across their own detections.
	//
	// fusion only started writing track.rssi_dbm partway through the project's
	// life. Tracks stored before that deploy have no such field, so /tracks and
	// /timeline rendered a dash for them while the detail page -- which
	// computes the peak client-side from the detections it fetches anyway --
	// rendered a real number for the same track. One track disagreeing with
	// itself on two screens reads as a bug rather than as history.
	//
	// Called by whatever SERVES a track, not by GetTrack and ListTracks
	// themselves. That is deliberate: both of those are also the read half of
	// a read-modify-write -- ingest closing a track it was told about, and the
	// stale sweep closing one fusion abandoned -- and enriching there would
	// launder a derived number into the stored document on a path nobody
	// looking at it would expect to write, and would put a detections
	// aggregate on the closure hot path. The stored document stays exactly
	// what fusion published; the repair lives in the response.
	//
	// A track that already carries a peak is never second-guessed, and a track
	// whose detections carry no RSSI at all is left absent rather than given a
	// confident 0 dBm. One query for the whole slice.
	BackfillPeakRSSI(ctx context.Context, tracks []model.Track) error

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

	// PutSweep writes the metadata; PutSweepBins writes the measurement. Two
	// calls because they have different lifetimes -- a sweep is recorded as
	// running before there are any bins, and a sweep that fails gets a reason
	// and never gets bins at all.
	PutSweep(ctx context.Context, s model.SpectrumSweep) error
	GetSweep(ctx context.Context, id string) (model.SpectrumSweep, error)
	ListSweeps(ctx context.Context, limit int) ([]model.SpectrumSweep, error)
	PutSweepBins(ctx context.Context, id string, bins json.RawMessage) error
	GetSweepBins(ctx context.Context, id string) (json.RawMessage, error)

	// Accounts and sessions. See internal/auth for why sessions are opaque
	// tokens stored as hashes rather than JWTs.
	CountUsers(ctx context.Context) (int64, error)
	CountAdmins(ctx context.Context) (int64, error)
	PutUser(ctx context.Context, u auth.User) error
	GetUser(ctx context.Context, id string) (auth.User, error)
	GetUserByUsername(ctx context.Context, username string) (auth.User, error)
	GetUserByOIDC(ctx context.Context, issuer, subject string) (auth.User, error)
	ListUsers(ctx context.Context) ([]auth.User, error)
	DeleteUser(ctx context.Context, id string) error

	PutSession(ctx context.Context, s auth.Session) error
	GetSession(ctx context.Context, id string) (auth.Session, error)
	TouchSession(ctx context.Context, id string, lastSeen, expiresAt time.Time) error
	DeleteSession(ctx context.Context, id string) error
	DeleteUserSessions(ctx context.Context, userID string) (int64, error)
	// ListSessions returns sessions newest-active first. A limit of zero or
	// less means NO limit -- callers revoking sessions depend on seeing all
	// of them, and a store that quietly caps instead leaves the ones it
	// truncated alive.
	ListSessions(ctx context.Context, limit int) ([]auth.Session, error)
	PurgeExpiredSessions(ctx context.Context, now time.Time) (int64, error)

	// Hook rules and their delivery history. Rules are stored whole, secrets
	// included -- redaction happens at the API edge, because the dispatcher
	// needs the real bearer token to actually deliver.
	PutHookRule(ctx context.Context, r hooks.Rule) error
	GetHookRule(ctx context.Context, id string) (hooks.Rule, error)
	ListHookRules(ctx context.Context) ([]hooks.Rule, error)
	DeleteHookRule(ctx context.Context, id string) error
	// MarkHookRuleFired bumps fire_count and stamps last_fired_at as a
	// targeted update. The dispatcher's workers call it concurrently; a
	// read-modify-write through PutHookRule loses increments and can clobber
	// an admin's concurrent edit with a worker's stale copy.
	MarkHookRuleFired(ctx context.Context, ruleID string, at time.Time) error
	PutHookDelivery(ctx context.Context, d hooks.Delivery) error
	// ListHookDeliveries returns deliveries newest first. As with
	// ListSessions, a limit of zero or less means NO limit.
	ListHookDeliveries(ctx context.Context, limit int) ([]hooks.Delivery, error)

	GetConfig(ctx context.Context, key string) (json.RawMessage, error)
	PutConfig(ctx context.Context, key string, value json.RawMessage) error

	InsertTelemetry(ctx context.Context, s TelemetrySample) error
	ListTelemetry(ctx context.Context, q TelemetryQuery) ([]TelemetrySample, error)

	PurgeDetections(ctx context.Context, before time.Time) (int64, error)
	PurgeTracks(ctx context.Context, before time.Time) (int64, error)
	PurgeTelemetry(ctx context.Context, before time.Time) (int64, error)
	PurgeSweeps(ctx context.Context, before time.Time) (int64, error)
	PurgeHookDeliveries(ctx context.Context, before time.Time) (int64, error)

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

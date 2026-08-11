// Package libsqlstore implements store.Store on libSQL.
//
// One database. With CLASSG_TURSO_URL set it is opened as an embedded replica
// that syncs to Turso; without it, it is a plain local file and the process
// makes no network calls at all. Offline is the default and the fully
// functional path -- a Pi in a field with no uplink records everything.
//
// The SQL in this file compiles everywhere because it only uses database/sql.
// Only opening the driver is platform-gated -- see open_libsql.go.
package libsqlstore

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

// dbTime is fixed-width on purpose.
//
// time.RFC3339Nano trims trailing zeros, which makes string comparison
// disagree with chronological order ("…:05Z" sorts after "…:05.5Z" because 'Z'
// > '.'). Keyset pagination compares these strings in SQL, so the width has to
// be constant or pages silently skip rows.
const dbTime = "2006-01-02T15:04:05.000000000Z"

func toDB(t time.Time) string { return t.UTC().Format(dbTime) }

func fromDB(s string) time.Time {
	t, err := time.Parse(dbTime, s)
	if err != nil {
		// Tolerate a row written in another format rather than failing a whole
		// page; a zero time sorts last and is visibly wrong rather than subtly.
		t, _ = time.Parse(time.RFC3339Nano, s)
	}
	return t.UTC()
}

type Options struct {
	// Path is the database file. With SyncURL set it becomes the local file
	// backing an embedded replica.
	Path string

	// SyncURL and AuthToken are optional. Empty means fully local operation
	// with no network calls -- the default, and the only mode a
	// field-deployed Pi is guaranteed to have.
	SyncURL      string
	AuthToken    string
	SyncInterval time.Duration
}

type Store struct {
	db *sql.DB
	// closeDriver tears down the embedded-replica connector, which owns native
	// resources that sql.DB.Close does not release.
	closeDriver func() error
	synced      bool
}

// Synced reports whether this database is an embedded replica rather than a
// purely local file.
func (s *Store) Synced() bool { return s.synced }

func Open(ctx context.Context, opts Options) (*Store, error) {
	if opts.Path == "" {
		return nil, errors.New("libsqlstore: Path is required")
	}
	db, closeDriver, synced, err := open(opts)
	if err != nil {
		return nil, err
	}
	// go-libsql's local file driver can open multiple SQLite connections, but
	// concurrent detection and track writes then race for SQLite's single writer
	// lock. A field detector values lossless ingestion over parallel SQL writes;
	// one pooled connection serializes them without application-level retries.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &Store{db: db, closeDriver: closeDriver, synced: synced}
	if err := s.migrate(ctx); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.closeDriver() }

func (s *Store) migrate(ctx context.Context) error {
	// These PRAGMAs RETURN A ROW -- journal_mode reports the resulting mode and
	// busy_timeout echoes the value. Running them through Exec always failed
	// with "Execute returned rows", so WAL was never actually enabled and the
	// warning was mistaken for libSQL declining it. Query, and check the answer
	// rather than assuming it.
	//
	// WAL is still requested rather than required: a libSQL embedded replica
	// manages its own journalling and may legitimately refuse. Local files --
	// every deployment without Turso credentials -- accept it.
	var mode string
	if err := s.db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		slog.Warn("could not enable WAL", "err", err)
	} else if !strings.EqualFold(mode, "wal") {
		slog.Info("journal mode is not WAL", "mode", mode,
			"note", "expected for an embedded replica, which journals its own way")
	}

	var busyTimeout int64
	if err := s.db.QueryRowContext(ctx, "PRAGMA busy_timeout=5000").Scan(&busyTimeout); err != nil {
		slog.Warn("could not set busy_timeout", "err", err)
	}

	// The schema is applied from the same file sqlc type-checks queries
	// against. Two copies of the DDL -- one here, one for codegen -- could
	// disagree, and the disagreement would only ever surface at runtime.
	for _, stmt := range splitStatements(schemaSQL) {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("migrate %q: %w", stmt, err)
		}
	}
	return nil
}

//go:embed sql/schema.sql
var schemaSQL string

// splitStatements breaks the schema into individual statements.
//
// database/sql executes one statement per call, and the schema is plain DDL
// with no procedural bodies or embedded semicolons, so splitting on ";" is
// sufficient -- deliberately not a general-purpose SQL parser.
func splitStatements(sql string) []string {
	var out []string
	for _, raw := range strings.Split(sql, ";") {
		stmt := strings.TrimSpace(stripSQLComments(raw))
		if stmt != "" {
			out = append(out, stmt)
		}
	}
	return out
}

// stripSQLComments drops whole-line -- comments so they do not become empty
// statements after the split.
func stripSQLComments(s string) string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

// --- tracks ----------------------------------------------------------------

func (s *Store) UpsertTrack(ctx context.Context, t model.Track) error {
	if t.TrackID == "" {
		return errors.New("upsert track: empty track_id")
	}
	doc, err := json.Marshal(t)
	if err != nil {
		return fmt.Errorf("upsert track: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO tracks (track_id, state, first_seen, last_seen, detection_count, confidence, serial, doc)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(track_id) DO UPDATE SET
			state=excluded.state, first_seen=excluded.first_seen, last_seen=excluded.last_seen,
			detection_count=excluded.detection_count, confidence=excluded.confidence,
			serial=excluded.serial, doc=excluded.doc`,
		t.TrackID, t.State, toDB(t.FirstSeen), toDB(t.LastSeen),
		t.DetectionCount, t.Confidence, nullString(t.Identity.Serial), string(doc))
	if err != nil {
		return fmt.Errorf("upsert track: %w", err)
	}
	return nil
}

func (s *Store) GetTrack(ctx context.Context, id string) (model.Track, error) {
	var doc string
	err := s.db.QueryRowContext(ctx, `SELECT doc FROM tracks WHERE track_id = ?`, id).Scan(&doc)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Track{}, store.ErrNotFound
	}
	if err != nil {
		return model.Track{}, fmt.Errorf("get track: %w", err)
	}
	var t model.Track
	if err := json.Unmarshal([]byte(doc), &t); err != nil {
		return model.Track{}, fmt.Errorf("get track: decoding stored doc: %w", err)
	}
	return t, nil
}

func (s *Store) ListTracks(ctx context.Context, q store.TrackQuery) (store.TrackPage, error) {
	where := []string{"1=1"}
	var args []any
	if len(q.States) > 0 {
		where = append(where, "state IN ("+placeholders(len(q.States))+")")
		for _, st := range q.States {
			args = append(args, st)
		}
	}
	if !q.Since.IsZero() {
		where = append(where, "last_seen >= ?")
		args = append(args, toDB(q.Since))
	}
	if q.MinConfidence > 0 {
		where = append(where, "confidence >= ?")
		args = append(args, q.MinConfidence)
	}
	clause := strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tracks WHERE `+clause, args...).Scan(&total); err != nil {
		return store.TrackPage{}, fmt.Errorf("list tracks: count: %w", err)
	}

	pageArgs := append([]any(nil), args...)
	pageClause := clause
	if q.Cursor != nil {
		pageClause += " AND (last_seen < ? OR (last_seen = ? AND track_id < ?))"
		c := toDB(q.Cursor.TS)
		pageArgs = append(pageArgs, c, c, q.Cursor.ID)
	}
	limit := q.Limit
	if limit <= 0 {
		limit = store.DefaultLimit
	}
	pageArgs = append(pageArgs, limit+1)

	rows, err := s.db.QueryContext(ctx, `SELECT doc, last_seen, track_id FROM tracks WHERE `+
		pageClause+` ORDER BY last_seen DESC, track_id DESC LIMIT ?`, pageArgs...)
	if err != nil {
		return store.TrackPage{}, fmt.Errorf("list tracks: %w", err)
	}
	defer rows.Close()

	page := store.TrackPage{Total: total, Tracks: []model.Track{}}
	var keys []store.Cursor
	for rows.Next() {
		var doc, lastSeen, id string
		if err := rows.Scan(&doc, &lastSeen, &id); err != nil {
			return store.TrackPage{}, fmt.Errorf("list tracks: scan: %w", err)
		}
		var t model.Track
		if err := json.Unmarshal([]byte(doc), &t); err != nil {
			return store.TrackPage{}, fmt.Errorf("list tracks: decoding stored doc: %w", err)
		}
		page.Tracks = append(page.Tracks, t)
		keys = append(keys, store.Cursor{TS: fromDB(lastSeen), ID: id})
	}
	if err := rows.Err(); err != nil {
		return store.TrackPage{}, fmt.Errorf("list tracks: %w", err)
	}
	if len(page.Tracks) > limit {
		page.Tracks = page.Tracks[:limit]
		page.NextCursor = keys[limit-1].Encode()
	}
	return page, nil
}

// --- detections ------------------------------------------------------------

func (s *Store) InsertDetection(ctx context.Context, d model.Detection) error {
	if d.DetectionID == "" {
		return errors.New("insert detection: empty detection_id")
	}
	doc, err := json.Marshal(d)
	if err != nil {
		return fmt.Errorf("insert detection: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO detections (detection_id, ts, sensor_id, sensor_kind, detection_class, serial, mac, doc)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(detection_id) DO NOTHING`,
		d.DetectionID, toDB(d.TS.Time), d.SensorID, d.SensorKind, d.DetectionClass,
		nullString(d.Identity.Serial), nullString(d.Identity.MAC), string(doc))
	if err != nil {
		return fmt.Errorf("insert detection: %w", err)
	}
	return nil
}

func (s *Store) ListDetections(ctx context.Context, q store.DetectionQuery) (store.DetectionPage, error) {
	where := []string{"1=1"}
	var args []any
	if len(q.Classes) > 0 {
		where = append(where, "detection_class IN ("+placeholders(len(q.Classes))+")")
		for _, c := range q.Classes {
			args = append(args, c)
		}
	}
	if q.SensorID != "" {
		where = append(where, "sensor_id = ?")
		args = append(args, q.SensorID)
	}
	if !q.Since.IsZero() {
		where = append(where, "ts >= ?")
		args = append(args, toDB(q.Since))
	}
	return s.detectionPage(ctx, strings.Join(where, " AND "), args, q.Limit, q.Cursor)
}

func (s *Store) ListTrackDetections(ctx context.Context, q store.TrackDetectionQuery) (store.DetectionPage, error) {
	var (
		idOr []string
		args []any
	)
	if q.Serial != "" {
		idOr = append(idOr, "serial = ?")
		args = append(args, q.Serial)
	}
	if len(q.MACs) > 0 {
		idOr = append(idOr, "mac IN ("+placeholders(len(q.MACs))+")")
		for _, m := range q.MACs {
			args = append(args, m)
		}
	}
	if len(idOr) == 0 {
		// A track with neither a serial nor a MAC cannot be joined to
		// detections at all. Empty is the honest answer.
		return store.DetectionPage{Detections: []model.Detection{}}, nil
	}
	where := []string{"(" + strings.Join(idOr, " OR ") + ")"}
	if !q.From.IsZero() {
		where = append(where, "ts >= ?")
		args = append(args, toDB(q.From))
	}
	if !q.To.IsZero() {
		where = append(where, "ts <= ?")
		args = append(args, toDB(q.To))
	}
	return s.detectionPage(ctx, strings.Join(where, " AND "), args, q.Limit, q.Cursor)
}

func (s *Store) detectionPage(ctx context.Context, clause string, args []any, limit int, cursor *store.Cursor) (store.DetectionPage, error) {
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM detections WHERE `+clause, args...).Scan(&total); err != nil {
		return store.DetectionPage{}, fmt.Errorf("list detections: count: %w", err)
	}

	pageArgs := append([]any(nil), args...)
	pageClause := clause
	if cursor != nil {
		pageClause += " AND (ts < ? OR (ts = ? AND detection_id < ?))"
		c := toDB(cursor.TS)
		pageArgs = append(pageArgs, c, c, cursor.ID)
	}
	if limit <= 0 {
		limit = store.DefaultLimit
	}
	pageArgs = append(pageArgs, limit+1)

	rows, err := s.db.QueryContext(ctx, `SELECT doc, ts, detection_id FROM detections WHERE `+
		pageClause+` ORDER BY ts DESC, detection_id DESC LIMIT ?`, pageArgs...)
	if err != nil {
		return store.DetectionPage{}, fmt.Errorf("list detections: %w", err)
	}
	defer rows.Close()

	page := store.DetectionPage{Total: total, Detections: []model.Detection{}}
	var keys []store.Cursor
	for rows.Next() {
		var doc, ts, id string
		if err := rows.Scan(&doc, &ts, &id); err != nil {
			return store.DetectionPage{}, fmt.Errorf("list detections: scan: %w", err)
		}
		var d model.Detection
		if err := json.Unmarshal([]byte(doc), &d); err != nil {
			return store.DetectionPage{}, fmt.Errorf("list detections: decoding stored doc: %w", err)
		}
		page.Detections = append(page.Detections, d)
		keys = append(keys, store.Cursor{TS: fromDB(ts), ID: id})
	}
	if err := rows.Err(); err != nil {
		return store.DetectionPage{}, fmt.Errorf("list detections: %w", err)
	}
	if len(page.Detections) > limit {
		page.Detections = page.Detections[:limit]
		page.NextCursor = keys[limit-1].Encode()
	}
	return page, nil
}

func (s *Store) DetectionCountsSince(ctx context.Context, since time.Time) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT sensor_id, COUNT(*) FROM detections WHERE ts >= ? GROUP BY sensor_id`, toDB(since))
	if err != nil {
		return nil, fmt.Errorf("detection counts: %w", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("detection counts: scan: %w", err)
		}
		out[id] = n
	}
	return out, rows.Err()
}

// --- sensors ---------------------------------------------------------------

func (s *Store) UpsertSensor(ctx context.Context, rec store.SensorRecord) error {
	var detail []byte
	if len(rec.Detail) > 0 {
		var err error
		if detail, err = json.Marshal(rec.Detail); err != nil {
			return fmt.Errorf("upsert sensor: %w", err)
		}
	}
	var hb any
	if !rec.LastHeartbeat.IsZero() {
		hb = toDB(rec.LastHeartbeat)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sensors (sensor_id, sensor_kind, last_heartbeat, healthy, reason, detail)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(sensor_id) DO UPDATE SET
			sensor_kind=excluded.sensor_kind, last_heartbeat=excluded.last_heartbeat,
			healthy=excluded.healthy, reason=excluded.reason, detail=excluded.detail`,
		rec.SensorID, rec.SensorKind, hb, rec.Healthy, nullString(rec.Reason), nullString(string(detail)))
	if err != nil {
		return fmt.Errorf("upsert sensor: %w", err)
	}
	return nil
}

func (s *Store) ListSensors(ctx context.Context) ([]store.SensorRecord, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT sensor_id, sensor_kind, last_heartbeat, healthy, reason, detail FROM sensors ORDER BY sensor_id`)
	if err != nil {
		return nil, fmt.Errorf("list sensors: %w", err)
	}
	defer rows.Close()
	var out []store.SensorRecord
	for rows.Next() {
		var (
			rec            store.SensorRecord
			hb, reason, dt sql.NullString
		)
		if err := rows.Scan(&rec.SensorID, &rec.SensorKind, &hb, &rec.Healthy, &reason, &dt); err != nil {
			return nil, fmt.Errorf("list sensors: scan: %w", err)
		}
		if hb.Valid {
			rec.LastHeartbeat = fromDB(hb.String)
		}
		rec.Reason = reason.String
		if dt.Valid && dt.String != "" {
			_ = json.Unmarshal([]byte(dt.String), &rec.Detail)
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// --- captures --------------------------------------------------------------

func (s *Store) PutCapture(ctx context.Context, c model.Capture) error {
	doc, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("put capture: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO captures (capture_id, doc, started_at) VALUES (?, ?, ?)
		ON CONFLICT(capture_id) DO UPDATE SET doc=excluded.doc, started_at=excluded.started_at`,
		c.CaptureID, string(doc), toDB(c.StartedAt))
	if err != nil {
		return fmt.Errorf("put capture: %w", err)
	}
	return nil
}

func (s *Store) GetCapture(ctx context.Context, id string) (model.Capture, error) {
	var doc string
	err := s.db.QueryRowContext(ctx, `SELECT doc FROM captures WHERE capture_id = ?`, id).Scan(&doc)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Capture{}, store.ErrNotFound
	}
	if err != nil {
		return model.Capture{}, fmt.Errorf("get capture: %w", err)
	}
	var c model.Capture
	if err := json.Unmarshal([]byte(doc), &c); err != nil {
		return model.Capture{}, fmt.Errorf("get capture: decoding stored doc: %w", err)
	}
	return c, nil
}

func (s *Store) ListCaptures(ctx context.Context) ([]model.Capture, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT doc FROM captures ORDER BY started_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list captures: %w", err)
	}
	defer rows.Close()
	var out []model.Capture
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return nil, fmt.Errorf("list captures: scan: %w", err)
		}
		var c model.Capture
		if err := json.Unmarshal([]byte(doc), &c); err != nil {
			return nil, fmt.Errorf("list captures: decoding stored doc: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) PutCaptureReport(ctx context.Context, id string, report json.RawMessage, summary model.CaptureAnalysis) error {
	c, err := s.GetCapture(ctx, id)
	if err != nil {
		return err
	}
	c.Analysis = &summary
	doc, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("put capture report: %w", err)
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE captures SET doc = ?, report = ? WHERE capture_id = ?`, string(doc), string(report), id)
	if err != nil {
		return fmt.Errorf("put capture report: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) GetCaptureReport(ctx context.Context, id string) (json.RawMessage, error) {
	var report sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT report FROM captures WHERE capture_id = ?`, id).Scan(&report)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get capture report: %w", err)
	}
	if !report.Valid || report.String == "" {
		return nil, store.ErrNotFound
	}
	return json.RawMessage(report.String), nil
}

// --- config ----------------------------------------------------------------

func (s *Store) GetConfig(ctx context.Context, key string) (json.RawMessage, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM config WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get config: %w", err)
	}
	return json.RawMessage(v), nil
}

func (s *Store) PutConfig(ctx context.Context, key string, value json.RawMessage) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		key, string(value), toDB(time.Now()))
	if err != nil {
		return fmt.Errorf("put config: %w", err)
	}
	return nil
}

// --- retention -------------------------------------------------------------

func (s *Store) PurgeDetections(ctx context.Context, before time.Time) (int64, error) {
	return exec(ctx, s.db, `DELETE FROM detections WHERE ts < ?`, toDB(before))
}

func (s *Store) PurgeTracks(ctx context.Context, before time.Time) (int64, error) {
	return exec(ctx, s.db, `DELETE FROM tracks WHERE last_seen < ?`, toDB(before))
}

func exec(ctx context.Context, db *sql.DB, query string, args ...any) (int64, error) {
	res, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, nil // driver does not report it; the delete still happened
	}
	return n, nil
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

var _ store.Store = (*Store)(nil)

// JournalMode reports the database's current journal mode. Exposed so a test
// can assert WAL is genuinely on rather than trusting a log line.
func (s *Store) JournalMode(ctx context.Context) (string, error) {
	var mode string
	err := s.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode)
	return mode, err
}

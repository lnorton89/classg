package libsqlstore

// Every method here delegates to sqlcgen, which is generated from
// sql/queries.sql and type-checked against sql/schema.sql. This file holds only
// the translation between the domain types and the generated parameter structs:
// no SQL text, and in particular no WHERE clause assembled from strings.
//
// An absent optional filter is passed as NULL and the query reads that as "no
// filter" rather than "match NULL". The distinction matters: treating a NULL
// serial as a filter value would quietly match every detection that has no
// serial yet, which early in a flight is most of them.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/libsqlstore/sqlcgen"
)

// --- parameter helpers -----------------------------------------------------

func nullStr(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

func nullTime(t time.Time) sql.NullString {
	if t.IsZero() {
		return sql.NullString{}
	}
	return sql.NullString{String: toDB(t), Valid: true}
}

func nullFloat(f float64, on bool) sql.NullFloat64 {
	return sql.NullFloat64{Float64: f, Valid: on}
}

// jsonSet encodes a set filter as a JSON array for json_each to expand, or NULL
// for "no filter". See the note at the top of queries.sql for why the set is a
// single JSON parameter rather than sqlc.slice().
func jsonSet[T ~string](vs []T) sql.NullString {
	if len(vs) == 0 {
		return sql.NullString{}
	}
	strs := make([]string, 0, len(vs))
	for _, v := range vs {
		strs = append(strs, string(v))
	}
	// A []string always marshals; the error is unreachable rather than ignored.
	b, err := json.Marshal(strs)
	if err != nil {
		return sql.NullString{}
	}
	return sql.NullString{String: string(b), Valid: true}
}

// cursorParams splits a keyset cursor into its two comparison parameters.
func cursorParams(c *store.Cursor) (ts, id sql.NullString) {
	if c == nil {
		return sql.NullString{}, sql.NullString{}
	}
	return sql.NullString{String: toDB(c.TS), Valid: true},
		sql.NullString{String: c.ID, Valid: true}
}

// pageLimit returns the caller's limit and the row count to actually request.
// One extra row is fetched so a next page can be detected without a second
// count query.
func pageLimit(limit int) (want int, fetch int64) {
	if limit <= 0 {
		limit = store.DefaultLimit
	}
	return limit, int64(limit) + 1
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
	err = s.q.UpsertTrack(ctx, sqlcgen.UpsertTrackParams{
		TrackID:        t.TrackID,
		State:          string(t.State),
		FirstSeen:      toDB(t.FirstSeen),
		LastSeen:       toDB(t.LastSeen),
		DetectionCount: int64(t.DetectionCount),
		Confidence:     t.Confidence,
		Serial:         nullStr(t.Identity.Serial),
		Doc:            string(doc),
	})
	if err != nil {
		return fmt.Errorf("upsert track: %w", err)
	}
	return nil
}

func (s *Store) GetTrack(ctx context.Context, id string) (model.Track, error) {
	doc, err := s.q.GetTrack(ctx, id)
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
	var (
		since         = nullTime(q.Since)
		minConfidence = nullFloat(q.MinConfidence, q.MinConfidence > 0)
		states        = jsonSet(q.States)
	)

	total, err := s.q.CountTracks(ctx, sqlcgen.CountTracksParams{
		Since:         since,
		MinConfidence: minConfidence,
		States:        states,
	})
	if err != nil {
		return store.TrackPage{}, fmt.Errorf("list tracks: count: %w", err)
	}

	limit, fetch := pageLimit(q.Limit)
	cursorTS, cursorID := cursorParams(q.Cursor)
	rows, err := s.q.ListTracks(ctx, sqlcgen.ListTracksParams{
		Since:         since,
		MinConfidence: minConfidence,
		States:        states,
		CursorTs:      cursorTS,
		CursorID:      cursorID,
		Limit:         fetch,
	})
	if err != nil {
		return store.TrackPage{}, fmt.Errorf("list tracks: %w", err)
	}

	page := store.TrackPage{Total: int(total), Tracks: []model.Track{}}
	var keys []store.Cursor
	for _, row := range rows {
		var t model.Track
		if err := json.Unmarshal([]byte(row.Doc), &t); err != nil {
			return store.TrackPage{}, fmt.Errorf("list tracks: decoding stored doc: %w", err)
		}
		page.Tracks = append(page.Tracks, t)
		keys = append(keys, store.Cursor{TS: fromDB(row.LastSeen), ID: row.TrackID})
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
	err = s.q.InsertDetection(ctx, sqlcgen.InsertDetectionParams{
		DetectionID:    d.DetectionID,
		Ts:             toDB(d.TS.Time),
		SensorID:       d.SensorID,
		SensorKind:     string(d.SensorKind),
		DetectionClass: string(d.DetectionClass),
		Serial:         nullStr(d.Identity.Serial),
		Mac:            nullStr(d.Identity.MAC),
		Doc:            string(doc),
	})
	if err != nil {
		return fmt.Errorf("insert detection: %w", err)
	}
	return nil
}

func (s *Store) ListDetections(ctx context.Context, q store.DetectionQuery) (store.DetectionPage, error) {
	var (
		since    = nullTime(q.Since)
		sensorID = nullStr(q.SensorID)
		classes  = jsonSet(q.Classes)
	)

	total, err := s.q.CountDetections(ctx, sqlcgen.CountDetectionsParams{
		Since:    since,
		SensorID: sensorID,
		Classes:  classes,
	})
	if err != nil {
		return store.DetectionPage{}, fmt.Errorf("list detections: count: %w", err)
	}

	limit, fetch := pageLimit(q.Limit)
	cursorTS, cursorID := cursorParams(q.Cursor)
	rows, err := s.q.ListDetections(ctx, sqlcgen.ListDetectionsParams{
		Since:    since,
		SensorID: sensorID,
		Classes:  classes,
		CursorTs: cursorTS,
		CursorID: cursorID,
		Limit:    fetch,
	})
	if err != nil {
		return store.DetectionPage{}, fmt.Errorf("list detections: %w", err)
	}

	keyed := make([]detectionRow, 0, len(rows))
	for _, r := range rows {
		keyed = append(keyed, detectionRow{doc: r.Doc, ts: r.Ts, id: r.DetectionID})
	}
	return buildDetectionPage(keyed, int(total), limit)
}

func (s *Store) ListTrackDetections(ctx context.Context, q store.TrackDetectionQuery) (store.DetectionPage, error) {
	if q.Serial == "" && len(q.MACs) == 0 {
		// A track with neither a serial nor a MAC cannot be joined to
		// detections at all. Empty is the honest answer.
		return store.DetectionPage{Detections: []model.Detection{}}, nil
	}
	var (
		serial = nullStr(q.Serial)
		macs   = jsonSet(q.MACs)
		from   = nullTime(q.From)
		to     = nullTime(q.To)
	)

	total, err := s.q.CountTrackDetections(ctx, sqlcgen.CountTrackDetectionsParams{
		Serial: serial,
		Macs:   macs,
		FromTs: from,
		ToTs:   to,
	})
	if err != nil {
		return store.DetectionPage{}, fmt.Errorf("list track detections: count: %w", err)
	}

	limit, fetch := pageLimit(q.Limit)
	cursorTS, cursorID := cursorParams(q.Cursor)
	rows, err := s.q.ListTrackDetections(ctx, sqlcgen.ListTrackDetectionsParams{
		Serial:   serial,
		Macs:     macs,
		FromTs:   from,
		ToTs:     to,
		CursorTs: cursorTS,
		CursorID: cursorID,
		Limit:    fetch,
	})
	if err != nil {
		return store.DetectionPage{}, fmt.Errorf("list track detections: %w", err)
	}

	keyed := make([]detectionRow, 0, len(rows))
	for _, r := range rows {
		keyed = append(keyed, detectionRow{doc: r.Doc, ts: r.Ts, id: r.DetectionID})
	}
	return buildDetectionPage(keyed, int(total), limit)
}

// detectionRow is the shape both detection list queries return. The generated
// row types are distinct structs with identical fields, so this exists purely
// so the paging logic is written once.
type detectionRow struct{ doc, ts, id string }

func buildDetectionPage(rows []detectionRow, total, limit int) (store.DetectionPage, error) {
	page := store.DetectionPage{Total: total, Detections: []model.Detection{}}
	var keys []store.Cursor
	for _, row := range rows {
		var d model.Detection
		if err := json.Unmarshal([]byte(row.doc), &d); err != nil {
			return store.DetectionPage{}, fmt.Errorf("list detections: decoding stored doc: %w", err)
		}
		page.Detections = append(page.Detections, d)
		keys = append(keys, store.Cursor{TS: fromDB(row.ts), ID: row.id})
	}
	if len(page.Detections) > limit {
		page.Detections = page.Detections[:limit]
		page.NextCursor = keys[limit-1].Encode()
	}
	return page, nil
}

func (s *Store) DetectionCountsSince(ctx context.Context, since time.Time) (map[string]int, error) {
	rows, err := s.q.DetectionCountsSince(ctx, toDB(since))
	if err != nil {
		return nil, fmt.Errorf("detection counts: %w", err)
	}
	out := map[string]int{}
	for _, r := range rows {
		out[r.SensorID] = int(r.Count)
	}
	return out, nil
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
	healthy := int64(0)
	if rec.Healthy {
		healthy = 1
	}
	err := s.q.UpsertSensor(ctx, sqlcgen.UpsertSensorParams{
		SensorID:      rec.SensorID,
		SensorKind:    rec.SensorKind,
		LastHeartbeat: nullTime(rec.LastHeartbeat),
		Healthy:       healthy,
		Reason:        nullStr(rec.Reason),
		Detail:        nullStr(string(detail)),
	})
	if err != nil {
		return fmt.Errorf("upsert sensor: %w", err)
	}
	return nil
}

func (s *Store) ListSensors(ctx context.Context) ([]store.SensorRecord, error) {
	rows, err := s.q.ListSensors(ctx)
	if err != nil {
		return nil, fmt.Errorf("list sensors: %w", err)
	}
	var out []store.SensorRecord
	for _, row := range rows {
		rec := store.SensorRecord{
			SensorID:   row.SensorID,
			SensorKind: row.SensorKind,
			Healthy:    row.Healthy != 0,
			Reason:     row.Reason.String,
		}
		if row.LastHeartbeat.Valid {
			rec.LastHeartbeat = fromDB(row.LastHeartbeat.String)
		}
		if row.Detail.Valid && row.Detail.String != "" {
			_ = json.Unmarshal([]byte(row.Detail.String), &rec.Detail)
		}
		out = append(out, rec)
	}
	return out, nil
}

// --- captures --------------------------------------------------------------

func (s *Store) PutCapture(ctx context.Context, c model.Capture) error {
	doc, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("put capture: %w", err)
	}
	err = s.q.PutCapture(ctx, sqlcgen.PutCaptureParams{
		CaptureID: c.CaptureID,
		Doc:       string(doc),
		StartedAt: toDB(c.StartedAt),
	})
	if err != nil {
		return fmt.Errorf("put capture: %w", err)
	}
	return nil
}

func (s *Store) GetCapture(ctx context.Context, id string) (model.Capture, error) {
	doc, err := s.q.GetCapture(ctx, id)
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
	docs, err := s.q.ListCaptures(ctx)
	if err != nil {
		return nil, fmt.Errorf("list captures: %w", err)
	}
	var out []model.Capture
	for _, doc := range docs {
		var c model.Capture
		if err := json.Unmarshal([]byte(doc), &c); err != nil {
			return nil, fmt.Errorf("list captures: decoding stored doc: %w", err)
		}
		out = append(out, c)
	}
	return out, nil
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
	n, err := s.q.PutCaptureReport(ctx, sqlcgen.PutCaptureReportParams{
		Doc:       string(doc),
		Report:    nullStr(string(report)),
		CaptureID: id,
	})
	if err != nil {
		return fmt.Errorf("put capture report: %w", err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) GetCaptureReport(ctx context.Context, id string) (json.RawMessage, error) {
	report, err := s.q.GetCaptureReport(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get capture report: %w", err)
	}
	// A capture exists but has not been analysed yet. Not-found is the right
	// answer for the report specifically.
	if !report.Valid || report.String == "" {
		return nil, store.ErrNotFound
	}
	return json.RawMessage(report.String), nil
}

// --- config ----------------------------------------------------------------

func (s *Store) GetConfig(ctx context.Context, key string) (json.RawMessage, error) {
	v, err := s.q.GetConfig(ctx, key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get config: %w", err)
	}
	return json.RawMessage(v), nil
}

func (s *Store) PutConfig(ctx context.Context, key string, value json.RawMessage) error {
	err := s.q.PutConfig(ctx, sqlcgen.PutConfigParams{
		Key:       key,
		Value:     string(value),
		UpdatedAt: toDB(time.Now()),
	})
	if err != nil {
		return fmt.Errorf("put config: %w", err)
	}
	return nil
}

// --- retention -------------------------------------------------------------

func (s *Store) PurgeDetections(ctx context.Context, before time.Time) (int64, error) {
	return s.q.PurgeDetections(ctx, toDB(before))
}

func (s *Store) PurgeTracks(ctx context.Context, before time.Time) (int64, error) {
	return s.q.PurgeTracks(ctx, toDB(before))
}

var _ store.Store = (*Store)(nil)

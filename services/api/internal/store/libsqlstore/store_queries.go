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

// ListSweeps takes a LIMIT because the query does; this is what an unbounded
// caller gets. Well above any sensible retention on a Pi, and small enough that
// a runaway sweeper cannot make the list endpoint the slowest thing in the API.
const defaultSweepLimit = 500

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

// peakRSSIKey is one element of the JSON array MaxTrackRSSI expands. The field
// names are the ones the query's json_extract paths read.
type peakRSSIKey struct {
	ID     string   `json:"id"`
	Serial string   `json:"serial,omitempty"`
	MACs   []string `json:"macs,omitempty"`
	From   string   `json:"from"`
	To     string   `json:"to"`
}

// BackfillPeakRSSI implements store.Store. One statement covers the whole
// slice: a per-track query would turn one list response into a hundred.
func (s *Store) BackfillPeakRSSI(ctx context.Context, tracks []model.Track) error {
	keys := make([]peakRSSIKey, 0, len(tracks))
	for _, t := range tracks {
		if !store.NeedsPeakRSSI(t) {
			continue
		}
		from, to := store.TrackDetectionWindow(t)
		keys = append(keys, peakRSSIKey{
			ID:     t.TrackID,
			Serial: t.Identity.Serial,
			MACs:   t.Identity.MACs,
			From:   toDB(from),
			To:     toDB(to),
		})
	}
	if len(keys) == 0 {
		return nil
	}

	arg, err := json.Marshal(keys)
	if err != nil {
		return fmt.Errorf("peak rssi: %w", err)
	}
	rows, err := s.q.MaxTrackRSSI(ctx, string(arg))
	if err != nil {
		return fmt.Errorf("peak rssi: %w", err)
	}

	peaks := make(map[string]float64, len(rows))
	for _, row := range rows {
		peaks[row.TrackID] = row.RssiDbm
	}
	for i := range tracks {
		// Re-check rather than trusting the key list to line up with the
		// slice: a track that already had a peak must keep the one fusion
		// published.
		if !store.NeedsPeakRSSI(tracks[i]) {
			continue
		}
		if peak, ok := peaks[tracks[i].TrackID]; ok {
			tracks[i].RSSIdBm = &peak
		}
	}
	return nil
}

func (s *Store) ListTracks(ctx context.Context, q store.TrackQuery) (store.TrackPage, error) {
	var (
		since          = nullTime(q.Since)
		lastSeenBefore = nullTime(q.LastSeenBefore)
		minConfidence  = nullFloat(q.MinConfidence, q.MinConfidence > 0)
		states         = jsonSet(q.States)
	)

	var total int64
	if !q.SkipTotal {
		var err error
		total, err = s.q.CountTracks(ctx, sqlcgen.CountTracksParams{
			Since:          since,
			LastSeenBefore: lastSeenBefore,
			MinConfidence:  minConfidence,
			States:         states,
		})
		if err != nil {
			return store.TrackPage{}, fmt.Errorf("list tracks: count: %w", err)
		}
	}

	limit, fetch := pageLimit(q.Limit)
	cursorTS, cursorID := cursorParams(q.Cursor)
	rows, err := s.q.ListTracks(ctx, sqlcgen.ListTracksParams{
		Since:          since,
		LastSeenBefore: lastSeenBefore,
		MinConfidence:  minConfidence,
		States:         states,
		CursorTs:       cursorTS,
		CursorID:       cursorID,
		Limit:          fetch,
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

	var total int64
	if !q.SkipTotal {
		var err error
		total, err = s.q.CountTrackDetections(ctx, sqlcgen.CountTrackDetectionsParams{
			Serial: serial,
			Macs:   macs,
			FromTs: from,
			ToTs:   to,
		})
		if err != nil {
			return store.DetectionPage{}, fmt.Errorf("list track detections: count: %w", err)
		}
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

// purgeBatch bounds one DELETE. Small enough that a batch clears in tens of
// milliseconds on a Pi's SD card, large enough that a week's backlog is a few
// dozen rounds rather than thousands.
const purgeBatch = 5000

// PurgeDetections deletes in batches, releasing the single pooled connection
// between rounds. The first sweep after a long power-off can owe hundreds of
// thousands of rows; one unbounded DELETE held the sole writer for seconds
// while ZMQ ingest callbacks queued behind it.
func (s *Store) PurgeDetections(ctx context.Context, before time.Time) (int64, error) {
	var total int64
	for {
		n, err := s.q.PurgeDetections(ctx, sqlcgen.PurgeDetectionsParams{
			Before: toDB(before),
			Batch:  purgeBatch,
		})
		total += n
		if err != nil {
			return total, err
		}
		if n < purgeBatch {
			return total, nil
		}
		if err := ctx.Err(); err != nil {
			return total, err
		}
	}
}

func (s *Store) PurgeTracks(ctx context.Context, before time.Time) (int64, error) {
	return s.q.PurgeTracks(ctx, toDB(before))
}

var _ store.Store = (*Store)(nil)

// telemetryDoc is the part of a sample kept as JSON rather than as columns:
// the per-sensor set changes whenever a sensor learns a new field, and
// normalising it would mean a schema change every time.
type telemetryDoc struct {
	UptimeS *int64                  `json:"uptime_s,omitempty"`
	Sensors []store.TelemetrySensor `json:"sensors,omitempty"`
}

func (s *Store) InsertTelemetry(ctx context.Context, sample store.TelemetrySample) error {
	doc, err := json.Marshal(telemetryDoc{UptimeS: sample.UptimeS, Sensors: sample.Sensors})
	if err != nil {
		return fmt.Errorf("insert telemetry: %w", err)
	}
	return s.q.InsertTelemetry(ctx, sqlcgen.InsertTelemetryParams{
		Ts:             toDB(sample.TS),
		CpuTempC:       nullFloatOf(sample.CPUTempC),
		Load1:          nullFloatOf(sample.Load1),
		MemAvailableKb: nullIntOf(sample.MemAvailableKB),
		DiskFreeBytes:  nullIntOf(sample.DiskFreeBytes),
		Doc:            string(doc),
	})
}

func (s *Store) ListTelemetry(ctx context.Context, q store.TelemetryQuery) ([]store.TelemetrySample, error) {
	rows, err := s.q.ListTelemetry(ctx, sqlcgen.ListTelemetryParams{
		Ts:    toDB(q.Since),
		Ts_2:  toDB(q.Until),
		Limit: int64(q.Limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list telemetry: %w", err)
	}
	out := make([]store.TelemetrySample, 0, len(rows))
	for _, row := range rows {
		sample := store.TelemetrySample{
			TS:             fromDB(row.Ts),
			CPUTempC:       floatFromDB(row.CpuTempC),
			Load1:          floatFromDB(row.Load1),
			MemAvailableKB: intFromDB(row.MemAvailableKb),
			DiskFreeBytes:  intFromDB(row.DiskFreeBytes),
		}
		var doc telemetryDoc
		// A sample whose doc will not parse still has usable host columns, and
		// dropping the row would put a hole in a chart for a reason that has
		// nothing to do with the reading.
		if err := json.Unmarshal([]byte(row.Doc), &doc); err == nil {
			sample.UptimeS = doc.UptimeS
			sample.Sensors = doc.Sensors
		}
		out = append(out, sample)
	}
	return out, nil
}

func (s *Store) PutSweep(ctx context.Context, sw model.SpectrumSweep) error {
	doc, err := json.Marshal(sw)
	if err != nil {
		return fmt.Errorf("put sweep: %w", err)
	}
	err = s.q.PutSweep(ctx, sqlcgen.PutSweepParams{
		SweepID:   sw.SweepID,
		Doc:       string(doc),
		StartedAt: toDB(sw.StartedAt),
	})
	if err != nil {
		return fmt.Errorf("put sweep: %w", err)
	}
	return nil
}

func (s *Store) GetSweep(ctx context.Context, id string) (model.SpectrumSweep, error) {
	doc, err := s.q.GetSweep(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return model.SpectrumSweep{}, store.ErrNotFound
	}
	if err != nil {
		return model.SpectrumSweep{}, fmt.Errorf("get sweep: %w", err)
	}
	var sw model.SpectrumSweep
	if err := json.Unmarshal([]byte(doc), &sw); err != nil {
		return model.SpectrumSweep{}, fmt.Errorf("get sweep: decoding stored doc: %w", err)
	}
	return sw, nil
}

func (s *Store) ListSweeps(ctx context.Context, limit int) ([]model.SpectrumSweep, error) {
	// Non-positive means no limit, matching memstore -- the third and last
	// place in this store that quietly substituted a cap. In ListSessions that
	// silently truncated the set a password change revokes; the other two were
	// only ever latent, but three functions disagreeing with their counterparts
	// about what zero means is a pattern rather than an accident.
	if limit <= 0 {
		limit = -1 // SQLite: a negative LIMIT is no limit.
	}
	docs, err := s.q.ListSweeps(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("list sweeps: %w", err)
	}
	out := make([]model.SpectrumSweep, 0, len(docs))
	for _, doc := range docs {
		var sw model.SpectrumSweep
		if err := json.Unmarshal([]byte(doc), &sw); err != nil {
			return nil, fmt.Errorf("list sweeps: decoding stored doc: %w", err)
		}
		out = append(out, sw)
	}
	return out, nil
}

func (s *Store) PutSweepBins(ctx context.Context, id string, bins json.RawMessage) error {
	if _, err := s.GetSweep(ctx, id); err != nil {
		return err
	}
	err := s.q.PutSweepBins(ctx, sqlcgen.PutSweepBinsParams{
		Bins:    nullStr(string(bins)),
		SweepID: id,
	})
	if err != nil {
		return fmt.Errorf("put sweep bins: %w", err)
	}
	return nil
}

// GetSweepBins reports ErrNotFound when the sweep exists but holds no
// measurement -- still running, or failed. Same shape as GetCaptureReport for
// an unanalysed capture: the parent is there, the payload is not.
func (s *Store) GetSweepBins(ctx context.Context, id string) (json.RawMessage, error) {
	bins, err := s.q.GetSweepBins(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get sweep bins: %w", err)
	}
	if !bins.Valid || bins.String == "" {
		return nil, store.ErrNotFound
	}
	return json.RawMessage(bins.String), nil
}

func (s *Store) PurgeSweeps(ctx context.Context, before time.Time) (int64, error) {
	return s.q.PurgeSweeps(ctx, toDB(before))
}

func (s *Store) PurgeTelemetry(ctx context.Context, before time.Time) (int64, error) {
	return s.q.PurgeTelemetry(ctx, toDB(before))
}

func nullFloatOf(v *float64) sql.NullFloat64 {
	if v == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *v, Valid: true}
}

func nullIntOf(v *int64) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *v, Valid: true}
}

func floatFromDB(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float64
	return &f
}

func intFromDB(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	i := v.Int64
	return &i
}

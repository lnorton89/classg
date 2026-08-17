// Package memstore is an in-process implementation of store.Store.
//
// It exists so the HTTP and CLI test suites can run without a CGO toolchain or
// native libSQL libraries, and so those suites stay fast enough to run on every
// save. It is not a production store: nothing here survives a restart.
//
// Both implementations are held to the same behaviour by the conformance suite
// in ../storetest.
package memstore

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

type Store struct {
	mu         sync.RWMutex
	tracks     map[string]model.Track
	detections map[string]model.Detection
	sensors    map[string]store.SensorRecord
	captures   map[string]model.Capture
	reports    map[string]json.RawMessage
	config     map[string]json.RawMessage
	telemetry  []store.TelemetrySample
	users      map[string]auth.User
	sessions   map[string]auth.Session
	sweeps     map[string]model.SpectrumSweep
	sweepBins  map[string]json.RawMessage
}

func New() *Store {
	return &Store{
		tracks:     map[string]model.Track{},
		detections: map[string]model.Detection{},
		sensors:    map[string]store.SensorRecord{},
		captures:   map[string]model.Capture{},
		reports:    map[string]json.RawMessage{},
		config:     map[string]json.RawMessage{},
		users:      map[string]auth.User{},
		sessions:   map[string]auth.Session{},
		sweeps:     map[string]model.SpectrumSweep{},
		sweepBins:  map[string]json.RawMessage{},
	}
}

func (s *Store) Close() error { return nil }

func (s *Store) UpsertTrack(_ context.Context, t model.Track) error {
	if t.TrackID == "" {
		return fmt.Errorf("upsert track: empty track_id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Copy the slices: the caller keeps its own live copy of the track and
	// would otherwise be able to mutate stored state from under a reader.
	t.History = append([]model.Position(nil), t.History...)
	t.Evidence = append([]model.Evidence(nil), t.Evidence...)
	s.tracks[t.TrackID] = t
	return nil
}

func (s *Store) GetTrack(_ context.Context, id string) (model.Track, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.tracks[id]
	if !ok {
		return model.Track{}, store.ErrNotFound
	}
	return t, nil
}

func (s *Store) ListTracks(_ context.Context, q store.TrackQuery) (store.TrackPage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	states := set(q.States)
	var matched []model.Track
	for _, t := range s.tracks {
		if len(states) > 0 && !states[t.State] {
			continue
		}
		if !q.Since.IsZero() && t.LastSeen.Before(q.Since) {
			continue
		}
		if t.Confidence < q.MinConfidence {
			continue
		}
		matched = append(matched, t)
	}
	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].LastSeen.Equal(matched[j].LastSeen) {
			return matched[i].LastSeen.After(matched[j].LastSeen)
		}
		return matched[i].TrackID > matched[j].TrackID
	})

	total := len(matched)
	if q.Cursor != nil {
		kept := matched[:0:0]
		for _, t := range matched {
			if q.Cursor.Before(t.LastSeen, t.TrackID) {
				kept = append(kept, t)
			}
		}
		matched = kept
	}

	page := store.TrackPage{Total: total, Tracks: []model.Track{}}
	limit := q.Limit
	if limit <= 0 {
		limit = store.DefaultLimit
	}
	if len(matched) > limit {
		last := matched[limit-1]
		page.NextCursor = store.Cursor{TS: last.LastSeen, ID: last.TrackID}.Encode()
		matched = matched[:limit]
	}
	page.Tracks = append(page.Tracks, matched...)
	return page, nil
}

func (s *Store) InsertDetection(_ context.Context, d model.Detection) error {
	if d.DetectionID == "" {
		return fmt.Errorf("insert detection: empty detection_id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.detections[d.DetectionID]; exists {
		return nil // detections are immutable; a replay is a no-op
	}
	s.detections[d.DetectionID] = d
	return nil
}

func (s *Store) ListDetections(_ context.Context, q store.DetectionQuery) (store.DetectionPage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	classes := set(q.Classes)
	var matched []model.Detection
	for _, d := range s.detections {
		if len(classes) > 0 && !classes[d.DetectionClass] {
			continue
		}
		if q.SensorID != "" && d.SensorID != q.SensorID {
			continue
		}
		if !q.Since.IsZero() && d.TS.Time.Before(q.Since) {
			continue
		}
		matched = append(matched, d)
	}
	return paginateDetections(matched, q.Limit, q.Cursor), nil
}

func (s *Store) ListTrackDetections(_ context.Context, q store.TrackDetectionQuery) (store.DetectionPage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if q.Serial == "" && len(q.MACs) == 0 {
		return store.DetectionPage{Detections: []model.Detection{}}, nil
	}
	macs := set(q.MACs)
	var matched []model.Detection
	for _, d := range s.detections {
		if !q.From.IsZero() && d.TS.Time.Before(q.From) {
			continue
		}
		if !q.To.IsZero() && d.TS.Time.After(q.To) {
			continue
		}
		bySerial := q.Serial != "" && d.Identity.Serial == q.Serial
		byMAC := d.Identity.MAC != "" && macs[d.Identity.MAC]
		if !bySerial && !byMAC {
			continue
		}
		matched = append(matched, d)
	}
	return paginateDetections(matched, q.Limit, q.Cursor), nil
}

func paginateDetections(matched []model.Detection, limit int, cursor *store.Cursor) store.DetectionPage {
	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].TS.Time.Equal(matched[j].TS.Time) {
			return matched[i].TS.Time.After(matched[j].TS.Time)
		}
		return matched[i].DetectionID > matched[j].DetectionID
	})

	total := len(matched)
	if cursor != nil {
		kept := matched[:0:0]
		for _, d := range matched {
			if cursor.Before(d.TS.Time, d.DetectionID) {
				kept = append(kept, d)
			}
		}
		matched = kept
	}

	page := store.DetectionPage{Total: total, Detections: []model.Detection{}}
	if limit <= 0 {
		limit = store.DefaultLimit
	}
	if len(matched) > limit {
		last := matched[limit-1]
		page.NextCursor = store.Cursor{TS: last.TS.Time, ID: last.DetectionID}.Encode()
		matched = matched[:limit]
	}
	page.Detections = append(page.Detections, matched...)
	return page
}

func (s *Store) DetectionCountsSince(_ context.Context, since time.Time) (map[string]int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]int{}
	for _, d := range s.detections {
		if d.TS.Time.Before(since) {
			continue
		}
		out[d.SensorID]++
	}
	return out, nil
}

func (s *Store) UpsertSensor(_ context.Context, rec store.SensorRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sensors[rec.SensorID] = rec
	return nil
}

func (s *Store) ListSensors(_ context.Context) ([]store.SensorRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]store.SensorRecord, 0, len(s.sensors))
	for _, rec := range s.sensors {
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SensorID < out[j].SensorID })
	return out, nil
}

func (s *Store) PutCapture(_ context.Context, c model.Capture) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.captures[c.CaptureID] = c
	return nil
}

func (s *Store) GetCapture(_ context.Context, id string) (model.Capture, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.captures[id]
	if !ok {
		return model.Capture{}, store.ErrNotFound
	}
	return c, nil
}

func (s *Store) ListCaptures(_ context.Context) ([]model.Capture, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Capture, 0, len(s.captures))
	for _, c := range s.captures {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	return out, nil
}

func (s *Store) PutCaptureReport(_ context.Context, id string, report json.RawMessage, summary model.CaptureAnalysis) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.captures[id]
	if !ok {
		return store.ErrNotFound
	}
	s.reports[id] = append(json.RawMessage(nil), report...)
	c.Analysis = &summary
	s.captures[id] = c
	return nil
}

func (s *Store) GetCaptureReport(_ context.Context, id string) (json.RawMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.reports[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return r, nil
}

func (s *Store) PutSweep(_ context.Context, sw model.SpectrumSweep) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweeps[sw.SweepID] = sw
	return nil
}

func (s *Store) GetSweep(_ context.Context, id string) (model.SpectrumSweep, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sw, ok := s.sweeps[id]
	if !ok {
		return model.SpectrumSweep{}, store.ErrNotFound
	}
	return sw, nil
}

func (s *Store) ListSweeps(_ context.Context, limit int) ([]model.SpectrumSweep, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.SpectrumSweep, 0, len(s.sweeps))
	for _, sw := range s.sweeps {
		out = append(out, sw)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *Store) PutSweepBins(_ context.Context, id string, bins json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sweeps[id]; !ok {
		return store.ErrNotFound
	}
	s.sweepBins[id] = append(json.RawMessage(nil), bins...)
	return nil
}

// GetSweepBins reports ErrNotFound for a sweep that exists but has no
// measurement -- one still running, or one that failed. "The sweep is there,
// its bins are not" is the honest answer, and it is the same shape
// GetCaptureReport gives for an unanalysed capture.
func (s *Store) GetSweepBins(_ context.Context, id string) (json.RawMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.sweepBins[id]
	if !ok || len(b) == 0 {
		return nil, store.ErrNotFound
	}
	return b, nil
}

func (s *Store) PurgeSweeps(_ context.Context, before time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for id, sw := range s.sweeps {
		if sw.StartedAt.Before(before) {
			delete(s.sweeps, id)
			delete(s.sweepBins, id)
			n++
		}
	}
	return n, nil
}

func (s *Store) GetConfig(_ context.Context, key string) (json.RawMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.config[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	return v, nil
}

func (s *Store) PutConfig(_ context.Context, key string, value json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.config[key] = append(json.RawMessage(nil), value...)
	return nil
}

func (s *Store) PurgeDetections(_ context.Context, before time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for id, d := range s.detections {
		if d.TS.Time.Before(before) {
			delete(s.detections, id)
			n++
		}
	}
	return n, nil
}

func (s *Store) PurgeTracks(_ context.Context, before time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for id, t := range s.tracks {
		if t.LastSeen.Before(before) {
			delete(s.tracks, id)
			n++
		}
	}
	return n, nil
}

func set(vals []string) map[string]bool {
	if len(vals) == 0 {
		return nil
	}
	m := make(map[string]bool, len(vals))
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			m[v] = true
		}
	}
	return m
}

var _ store.Store = (*Store)(nil)

// Telemetry is kept as an ordered slice rather than a map: samples are appended
// in time order, read as a range, and never looked up individually.
func (s *Store) InsertTelemetry(_ context.Context, sample store.TelemetrySample) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Same rule as the ON CONFLICT DO NOTHING in SQL: a duplicate timestamp is
	// a restart inside one sampling interval, not a reason to fail.
	for _, existing := range s.telemetry {
		if existing.TS.Equal(sample.TS) {
			return nil
		}
	}
	s.telemetry = append(s.telemetry, sample)
	sort.Slice(s.telemetry, func(i, j int) bool { return s.telemetry[i].TS.Before(s.telemetry[j].TS) })
	return nil
}

func (s *Store) ListTelemetry(_ context.Context, q store.TelemetryQuery) ([]store.TelemetrySample, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []store.TelemetrySample{}
	for _, sample := range s.telemetry {
		if sample.TS.Before(q.Since) || sample.TS.After(q.Until) {
			continue
		}
		if q.Limit > 0 && len(out) >= q.Limit {
			break
		}
		out = append(out, sample)
	}
	return out, nil
}

func (s *Store) PurgeTelemetry(_ context.Context, before time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.telemetry[:0]
	var n int64
	for _, sample := range s.telemetry {
		if sample.TS.Before(before) {
			n++
			continue
		}
		kept = append(kept, sample)
	}
	s.telemetry = kept
	return n, nil
}

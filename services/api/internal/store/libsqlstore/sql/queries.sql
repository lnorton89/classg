-- Every statement the store runs. sqlc type-checks each one against
-- schema.sql and generates the Go, so a column that no longer exists is a
-- build failure rather than a runtime error on a detector that is mid-flight.
--
-- The list queries previously concatenated WHERE clauses in Go. They are now
-- single statements with NULL-guarded optional filters: `sqlc.narg('x') IS NULL
-- OR col = sqlc.narg('x')`. That trades a little index selectivity for queries
-- that can be verified at build time and have no string-building to get wrong.
-- At a Pi's data volumes -- weeks of detections, not billions -- the trade is
-- firmly worth it.

-- name: UpsertTrack :exec
INSERT INTO tracks (
    track_id, state, first_seen, last_seen, detection_count, confidence, serial, doc
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(track_id) DO UPDATE SET
    state           = excluded.state,
    first_seen      = excluded.first_seen,
    last_seen       = excluded.last_seen,
    detection_count = excluded.detection_count,
    confidence      = excluded.confidence,
    serial          = excluded.serial,
    doc             = excluded.doc;

-- name: GetTrack :one
SELECT doc FROM tracks WHERE track_id = ?;

-- name: CountTracks :one
SELECT COUNT(*) FROM tracks
WHERE (CAST(sqlc.narg('since') AS TEXT)          IS NULL OR last_seen  >= sqlc.narg('since'))
  AND (CAST(sqlc.narg('min_confidence') AS REAL) IS NULL OR confidence >= sqlc.narg('min_confidence'))
  AND (CAST(sqlc.narg('filter_states') AS INTEGER)  IS NULL OR state IN (sqlc.slice('states')));

-- name: ListTracks :many
-- Keyset paging on (last_seen DESC, track_id DESC), matching idx_tracks_page.
-- Offset paging would silently skip rows on a table being appended to.
SELECT doc, last_seen, track_id FROM tracks
WHERE (CAST(sqlc.narg('since') AS TEXT)          IS NULL OR last_seen  >= sqlc.narg('since'))
  AND (CAST(sqlc.narg('min_confidence') AS REAL) IS NULL OR confidence >= sqlc.narg('min_confidence'))
  AND (CAST(sqlc.narg('filter_states') AS INTEGER)  IS NULL OR state IN (sqlc.slice('states')))
  AND (
        CAST(sqlc.narg('cursor_ts') AS TEXT) IS NULL
        OR last_seen < sqlc.narg('cursor_ts')
        OR (last_seen = sqlc.narg('cursor_ts') AND track_id < sqlc.narg('cursor_id'))
      )
ORDER BY last_seen DESC, track_id DESC
LIMIT ?;

-- name: InsertDetection :exec
INSERT INTO detections (
    detection_id, ts, sensor_id, sensor_kind, detection_class, serial, mac, doc
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(detection_id) DO NOTHING;

-- name: CountDetections :one
SELECT COUNT(*) FROM detections
WHERE (CAST(sqlc.narg('since') AS TEXT)      IS NULL OR ts        >= sqlc.narg('since'))
  AND (CAST(sqlc.narg('sensor_id') AS TEXT)  IS NULL OR sensor_id  = sqlc.narg('sensor_id'))
  AND (CAST(sqlc.narg('filter_classes') AS INTEGER) IS NULL OR detection_class IN (sqlc.slice('classes')));

-- name: ListDetections :many
SELECT doc, ts, detection_id FROM detections
WHERE (CAST(sqlc.narg('since') AS TEXT)      IS NULL OR ts        >= sqlc.narg('since'))
  AND (CAST(sqlc.narg('sensor_id') AS TEXT)  IS NULL OR sensor_id  = sqlc.narg('sensor_id'))
  AND (CAST(sqlc.narg('filter_classes') AS INTEGER) IS NULL OR detection_class IN (sqlc.slice('classes')))
  AND (
        CAST(sqlc.narg('cursor_ts') AS TEXT) IS NULL
        OR ts < sqlc.narg('cursor_ts')
        OR (ts = sqlc.narg('cursor_ts') AND detection_id < sqlc.narg('cursor_id'))
      )
ORDER BY ts DESC, detection_id DESC
LIMIT ?;

-- name: DetectionCountsSince :many
-- Powers /health's detections_5m, which is how a quiet sky is told apart from
-- a broken sensor.
SELECT sensor_id, COUNT(*) AS count FROM detections
WHERE ts >= ?
GROUP BY sensor_id;

-- name: PurgeDetections :execrows
DELETE FROM detections WHERE ts < ?;

-- name: PurgeTracks :execrows
DELETE FROM tracks WHERE last_seen < ?;

-- name: UpsertSensor :exec
INSERT INTO sensors (sensor_id, sensor_kind, last_heartbeat, healthy, reason, detail)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(sensor_id) DO UPDATE SET
    sensor_kind    = excluded.sensor_kind,
    last_heartbeat = excluded.last_heartbeat,
    healthy        = excluded.healthy,
    reason         = excluded.reason,
    detail         = excluded.detail;

-- name: ListSensors :many
SELECT sensor_id, sensor_kind, last_heartbeat, healthy, reason, detail
FROM sensors ORDER BY sensor_id;

-- name: PutCapture :exec
INSERT INTO captures (capture_id, doc, started_at) VALUES (?, ?, ?)
ON CONFLICT(capture_id) DO UPDATE SET
    doc        = excluded.doc,
    started_at = excluded.started_at;

-- name: GetCapture :one
SELECT doc FROM captures WHERE capture_id = ?;

-- name: ListCaptures :many
SELECT doc FROM captures ORDER BY started_at DESC;

-- name: PutCaptureReport :exec
UPDATE captures SET report = ? WHERE capture_id = ?;

-- name: GetCaptureReport :one
SELECT report FROM captures WHERE capture_id = ?;

-- name: GetConfig :one
SELECT value FROM config WHERE key = ?;

-- name: PutConfig :exec
INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
    value      = excluded.value,
    updated_at = excluded.updated_at;

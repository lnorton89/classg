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
--
-- Set filters ("state IN (...)") pass a JSON array as ONE parameter and expand
-- it with json_each, rather than using sqlc.slice(). That is not a style
-- preference. sqlc numbers parameters explicitly (?1, ?2, ...) as soon as a
-- query uses named parameters, but sqlc.slice() expands to bare `?`, which
-- SQLite numbers as "one past the highest so far". The two schemes only agree
-- when the slice happens to hold exactly one element; at zero or two the
-- parameters after it silently shift and a confidence float ends up compared
-- against a timestamp. A JSON array is a single parameter of fixed position, so
-- the numbering cannot drift, and NULL still means "no filter".

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
  AND (CAST(sqlc.narg('states') AS TEXT)         IS NULL
       OR state IN (SELECT value FROM json_each(sqlc.narg('states'))));

-- name: ListTracks :many
-- Keyset paging on (last_seen DESC, track_id DESC), matching idx_tracks_page.
-- Offset paging would silently skip rows on a table being appended to.
SELECT doc, last_seen, track_id FROM tracks
WHERE (CAST(sqlc.narg('since') AS TEXT)          IS NULL OR last_seen  >= sqlc.narg('since'))
  AND (CAST(sqlc.narg('min_confidence') AS REAL) IS NULL OR confidence >= sqlc.narg('min_confidence'))
  AND (CAST(sqlc.narg('states') AS TEXT)         IS NULL
       OR state IN (SELECT value FROM json_each(sqlc.narg('states'))))
  AND (
        CAST(sqlc.narg('cursor_ts') AS TEXT) IS NULL
        OR last_seen < sqlc.narg('cursor_ts')
        OR (last_seen = sqlc.narg('cursor_ts') AND track_id < sqlc.narg('cursor_id'))
      )
ORDER BY last_seen DESC, track_id DESC
LIMIT sqlc.arg('limit');

-- name: InsertDetection :exec
INSERT INTO detections (
    detection_id, ts, sensor_id, sensor_kind, detection_class, serial, mac, doc
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(detection_id) DO NOTHING;

-- name: CountDetections :one
SELECT COUNT(*) FROM detections
WHERE (CAST(sqlc.narg('since') AS TEXT)     IS NULL OR ts        >= sqlc.narg('since'))
  AND (CAST(sqlc.narg('sensor_id') AS TEXT) IS NULL OR sensor_id  = sqlc.narg('sensor_id'))
  AND (CAST(sqlc.narg('classes') AS TEXT)   IS NULL
       OR detection_class IN (SELECT value FROM json_each(sqlc.narg('classes'))));

-- name: ListDetections :many
SELECT doc, ts, detection_id FROM detections
WHERE (CAST(sqlc.narg('since') AS TEXT)     IS NULL OR ts        >= sqlc.narg('since'))
  AND (CAST(sqlc.narg('sensor_id') AS TEXT) IS NULL OR sensor_id  = sqlc.narg('sensor_id'))
  AND (CAST(sqlc.narg('classes') AS TEXT)   IS NULL
       OR detection_class IN (SELECT value FROM json_each(sqlc.narg('classes'))))
  AND (
        CAST(sqlc.narg('cursor_ts') AS TEXT) IS NULL
        OR ts < sqlc.narg('cursor_ts')
        OR (ts = sqlc.narg('cursor_ts') AND detection_id < sqlc.narg('cursor_id'))
      )
ORDER BY ts DESC, detection_id DESC
LIMIT sqlc.arg('limit');

-- Reconstructing one track's detections matches on serial OR MAC, because a
-- track is keyed by MAC until Basic ID arrives and by serial afterwards, and
-- the same flight has rows from both eras.
--
-- Note the shape: each side of the OR is guarded by its own NOT NULL check, so
-- a track with only a MAC does not accidentally match every row whose serial is
-- NULL -- which, early in a flight, is most of them. The caller returns early
-- when a track has neither.

-- name: CountTrackDetections :one
SELECT COUNT(*) FROM detections
WHERE (
        (CAST(sqlc.narg('serial') AS TEXT) IS NOT NULL AND serial = sqlc.narg('serial'))
     OR (CAST(sqlc.narg('macs') AS TEXT) IS NOT NULL
         AND mac IN (SELECT value FROM json_each(sqlc.narg('macs'))))
      )
  AND (CAST(sqlc.narg('from_ts') AS TEXT) IS NULL OR ts >= sqlc.narg('from_ts'))
  AND (CAST(sqlc.narg('to_ts')   AS TEXT) IS NULL OR ts <= sqlc.narg('to_ts'));

-- name: ListTrackDetections :many
SELECT doc, ts, detection_id FROM detections
WHERE (
        (CAST(sqlc.narg('serial') AS TEXT) IS NOT NULL AND serial = sqlc.narg('serial'))
     OR (CAST(sqlc.narg('macs') AS TEXT) IS NOT NULL
         AND mac IN (SELECT value FROM json_each(sqlc.narg('macs'))))
      )
  AND (CAST(sqlc.narg('from_ts') AS TEXT) IS NULL OR ts >= sqlc.narg('from_ts'))
  AND (CAST(sqlc.narg('to_ts')   AS TEXT) IS NULL OR ts <= sqlc.narg('to_ts'))
  AND (
        CAST(sqlc.narg('cursor_ts') AS TEXT) IS NULL
        OR ts < sqlc.narg('cursor_ts')
        OR (ts = sqlc.narg('cursor_ts') AND detection_id < sqlc.narg('cursor_id'))
      )
ORDER BY ts DESC, detection_id DESC
LIMIT sqlc.arg('limit');

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

-- name: PutCaptureReport :execrows
-- doc is rewritten alongside the report because the analysis summary lives in
-- the capture document too; writing only one of the pair would leave a capture
-- whose summary and report disagree. :execrows so a missing capture_id is
-- reported as not-found rather than passing silently.
UPDATE captures SET doc = ?, report = ? WHERE capture_id = ?;

-- name: GetCaptureReport :one
SELECT report FROM captures WHERE capture_id = ?;

-- name: GetConfig :one
SELECT value FROM config WHERE key = ?;

-- name: PutConfig :exec
INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
    value      = excluded.value,
    updated_at = excluded.updated_at;

-- name: InsertTelemetry :exec
-- Ignores a duplicate timestamp rather than failing: two samplers, or a restart
-- inside one sampling interval, must not take the api down.
INSERT INTO telemetry (ts, cpu_temp_c, load1, mem_available_kb, disk_free_bytes, doc)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(ts) DO NOTHING;

-- name: ListTelemetry :many
-- Ascending, because every consumer is a chart and a chart reads left to right.
SELECT ts, cpu_temp_c, load1, mem_available_kb, disk_free_bytes, doc
FROM telemetry
WHERE ts >= ? AND ts <= ?
ORDER BY ts ASC
LIMIT ?;

-- name: PurgeTelemetry :execrows
DELETE FROM telemetry WHERE ts < ?;

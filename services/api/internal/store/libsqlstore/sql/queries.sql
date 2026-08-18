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

-- name: PutSweep :exec
INSERT INTO spectrum_sweeps (sweep_id, doc, started_at)
VALUES (?, ?, ?)
ON CONFLICT(sweep_id) DO UPDATE SET doc = excluded.doc;

-- name: PutSweepBins :exec
-- Separate from PutSweep so finishing a sweep does not rewrite the megabyte,
-- and so a failed sweep stores its reason without storing an empty blob.
UPDATE spectrum_sweeps SET bins = ? WHERE sweep_id = ?;

-- name: GetSweep :one
SELECT doc FROM spectrum_sweeps WHERE sweep_id = ?;

-- name: GetSweepBins :one
SELECT bins FROM spectrum_sweeps WHERE sweep_id = ?;

-- name: ListSweeps :many
-- Newest first, and deliberately without `bins`: the list is a menu, and
-- dragging every measurement off disk to render it would make the page cost
-- megabytes to answer "which sweeps do I have".
SELECT doc FROM spectrum_sweeps ORDER BY started_at DESC LIMIT ?;

-- name: PurgeSweeps :execrows
DELETE FROM spectrum_sweeps WHERE started_at < ?;

-- name: CountUsers :one
SELECT COUNT(*) FROM users;

-- name: PutUser :exec
INSERT INTO users (user_id, username, display_name, role, password_hash, issuer, subject,
                   disabled, created_at, updated_at, last_login_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name,
    role = excluded.role,
    password_hash = excluded.password_hash,
    issuer = excluded.issuer,
    subject = excluded.subject,
    disabled = excluded.disabled,
    updated_at = excluded.updated_at,
    last_login_at = excluded.last_login_at;

-- name: GetUser :one
SELECT user_id, username, display_name, role, password_hash, issuer, subject,
       disabled, created_at, updated_at, last_login_at
FROM users WHERE user_id = ?;

-- name: GetUserByUsername :one
SELECT user_id, username, display_name, role, password_hash, issuer, subject,
       disabled, created_at, updated_at, last_login_at
FROM users WHERE username = ?;

-- name: GetUserByOIDC :one
-- `issuer <> ''` is load-bearing, not tidiness. Local accounts store ('',''),
-- so without it a lookup with an empty issuer matches the first local account
-- it finds -- and an SSO login would come back as an existing operator. The
-- memstore refuses an empty issuer explicitly; this is the SQL half of the same
-- rule, and storetest checks both.
SELECT user_id, username, display_name, role, password_hash, issuer, subject,
       disabled, created_at, updated_at, last_login_at
FROM users WHERE issuer = ? AND issuer <> '' AND subject = ?;

-- name: ListUsers :many
SELECT user_id, username, display_name, role, password_hash, issuer, subject,
       disabled, created_at, updated_at, last_login_at
FROM users ORDER BY username ASC;

-- name: DeleteUser :execrows
DELETE FROM users WHERE user_id = ?;

-- name: CountAdmins :one
-- Guards the last admin. Deleting or demoting the only one leaves a box nobody
-- can administer, recoverable only by editing the database by hand.
SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0;

-- name: PutSession :exec
INSERT INTO sessions (session_id, user_id, created_at, expires_at, last_seen, user_agent, ip)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetSession :one
SELECT session_id, user_id, created_at, expires_at, last_seen, user_agent, ip
FROM sessions WHERE session_id = ?;

-- name: TouchSession :exec
UPDATE sessions SET last_seen = ?, expires_at = ? WHERE session_id = ?;

-- name: DeleteSession :execrows
DELETE FROM sessions WHERE session_id = ?;

-- name: DeleteUserSessions :execrows
DELETE FROM sessions WHERE user_id = ?;

-- name: ListSessions :many
SELECT session_id, user_id, created_at, expires_at, last_seen, user_agent, ip
FROM sessions ORDER BY last_seen DESC LIMIT ?;

-- name: PurgeExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at < ?;

-- name: PutHookRule :exec
INSERT INTO hook_rules (rule_id, name, enabled, event, action, doc, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rule_id) DO UPDATE SET
    name = excluded.name,
    enabled = excluded.enabled,
    event = excluded.event,
    action = excluded.action,
    doc = excluded.doc,
    updated_at = excluded.updated_at;

-- name: GetHookRule :one
SELECT doc FROM hook_rules WHERE rule_id = ?;

-- name: ListHookRules :many
SELECT doc FROM hook_rules ORDER BY created_at ASC;

-- name: DeleteHookRule :execrows
DELETE FROM hook_rules WHERE rule_id = ?;

-- name: PutHookDelivery :exec
INSERT INTO hook_deliveries (delivery_id, rule_id, rule_name, event, subject, status,
                             attempts, error, response_code, created_at, completed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(delivery_id) DO UPDATE SET
    status = excluded.status,
    attempts = excluded.attempts,
    error = excluded.error,
    response_code = excluded.response_code,
    completed_at = excluded.completed_at;

-- name: ListHookDeliveries :many
SELECT delivery_id, rule_id, rule_name, event, subject, status, attempts, error,
       response_code, created_at, completed_at
FROM hook_deliveries ORDER BY created_at DESC LIMIT ?;

-- name: PurgeHookDeliveries :execrows
DELETE FROM hook_deliveries WHERE created_at < ?;

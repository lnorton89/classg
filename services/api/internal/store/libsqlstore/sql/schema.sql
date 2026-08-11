-- ClassG storage schema. THE source of truth for the database.
--
-- Applied verbatim at startup (embedded via go:embed) and read by sqlc to type
-- every query in queries.sql. One definition, so a query cannot drift from the
-- table it reads: a column renamed here fails `sqlc generate` rather than
-- failing at runtime against a detector that is mid-flight.
--
-- Shape note: tracks, detections and captures keep the full record as JSON in
-- `doc`, with a handful of columns lifted out for indexing and paging. The wire
-- format is defined by schemas/*.schema.json and changes with the protocol; a
-- fully normalised mirror of it would have to be migrated every time a sensor
-- learned a new field, and would still be reassembled into the same struct on
-- the way out.

CREATE TABLE IF NOT EXISTS tracks (
    track_id        TEXT PRIMARY KEY,
    state           TEXT    NOT NULL,
    first_seen      TEXT    NOT NULL,
    last_seen       TEXT    NOT NULL,
    detection_count INTEGER NOT NULL,
    confidence      REAL    NOT NULL,
    serial          TEXT,
    doc             TEXT    NOT NULL
);

-- Keyset paging is (last_seen DESC, track_id DESC); the index matches exactly.
CREATE INDEX IF NOT EXISTS idx_tracks_page ON tracks (last_seen DESC, track_id DESC);

CREATE TABLE IF NOT EXISTS detections (
    detection_id    TEXT PRIMARY KEY,
    ts              TEXT NOT NULL,
    sensor_id       TEXT NOT NULL,
    sensor_kind     TEXT NOT NULL,
    detection_class TEXT NOT NULL,
    serial          TEXT,
    mac             TEXT,
    doc             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_detections_page ON detections (ts DESC, detection_id DESC);
CREATE INDEX IF NOT EXISTS idx_detections_sensor ON detections (sensor_id, ts DESC);
-- serial and mac both exist because reconstructing a track's detections matches
-- on either: a track is keyed by serial once Basic ID arrives, and by MAC
-- before that.
CREATE INDEX IF NOT EXISTS idx_detections_serial ON detections (serial, ts DESC);
CREATE INDEX IF NOT EXISTS idx_detections_mac ON detections (mac, ts DESC);

CREATE TABLE IF NOT EXISTS sensors (
    sensor_id      TEXT PRIMARY KEY,
    sensor_kind    TEXT    NOT NULL,
    last_heartbeat TEXT,
    healthy        INTEGER NOT NULL DEFAULT 0,
    reason         TEXT,
    detail         TEXT
);

CREATE TABLE IF NOT EXISTS captures (
    capture_id TEXT PRIMARY KEY,
    doc        TEXT NOT NULL,
    started_at TEXT NOT NULL,
    report     TEXT
);

CREATE TABLE IF NOT EXISTS config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

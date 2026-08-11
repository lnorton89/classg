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
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/classg/api/internal/store/libsqlstore/sqlcgen"
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
	// q is the generated querier. Every statement the store runs comes from
	// sql/queries.sql through it; db is kept only for migration and PRAGMAs,
	// which are DDL and connection settings rather than queries.
	q *sqlcgen.Queries
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
	s := &Store{db: db, q: sqlcgen.New(db), closeDriver: closeDriver, synced: synced}
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
	// Comments are stripped BEFORE splitting, not after. A semicolon inside a
	// comment -- and there is one, in schema.sql's own header prose -- would
	// otherwise end a "statement" mid-sentence and leave the remaining words to
	// be executed as SQL. That is exactly how this broke the first time.
	for _, raw := range strings.Split(stripSQLComments(sql), ";") {
		if stmt := strings.TrimSpace(raw); stmt != "" {
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

// JournalMode reports the database's current journal mode. Exposed so a test
// can assert WAL is genuinely on rather than trusting a log line.
func (s *Store) JournalMode(ctx context.Context) (string, error) {
	var mode string
	err := s.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode)
	return mode, err
}

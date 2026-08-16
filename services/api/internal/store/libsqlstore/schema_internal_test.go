package libsqlstore

import (
	"strings"
	"testing"
)

// splitStatements is pure, so unlike the round-trip migration test it runs on
// every platform -- including a cgo-less build with no libSQL. The bug it
// guards shipped precisely because the only coverage skipped there and CI was
// the first thing to notice.

func TestCommentsAreStrippedBeforeSplitting(t *testing.T) {
	// schema.sql's own header contains "changes with the protocol; a". Splitting
	// on ";" first left " a" as a statement, and SQLite duly reported
	// `near "a": syntax error` on a fresh database.
	schema := `
-- A note about the protocol; and a second clause after that semicolon.
CREATE TABLE t (id TEXT PRIMARY KEY);
`
	got := splitStatements(schema)
	if len(got) != 1 {
		t.Fatalf("got %d statements, want 1: %#v", len(got), got)
	}
	if !strings.HasPrefix(got[0], "CREATE TABLE") {
		t.Fatalf("statement starts with prose, not SQL: %q", got[0])
	}
}

func TestSplitsEveryStatement(t *testing.T) {
	schema := `
CREATE TABLE a (id TEXT);
CREATE INDEX idx_a ON a (id);
CREATE TABLE b (id TEXT);
`
	if got := splitStatements(schema); len(got) != 3 {
		t.Fatalf("got %d statements, want 3: %#v", len(got), got)
	}
}

func TestIgnoresBlankAndCommentOnlyInput(t *testing.T) {
	for _, in := range []string{"", "\n\n", "-- only a comment\n", "-- one;\n-- two;\n"} {
		if got := splitStatements(in); len(got) != 0 {
			t.Fatalf("%q produced %#v, want none", in, got)
		}
	}
}

func TestShippedSchemaIsAllStatements(t *testing.T) {
	// The real file, checked without needing a database: every statement must
	// begin with DDL rather than leftover prose.
	stmts := splitStatements(schemaSQL)
	if len(stmts) == 0 {
		t.Fatal("the embedded schema produced no statements")
	}
	for _, stmt := range stmts {
		upper := strings.ToUpper(stmt)
		if !strings.HasPrefix(upper, "CREATE") {
			t.Fatalf("statement does not start with CREATE:\n%s", stmt)
		}
	}
}

func TestSchemaDefinesTheExpectedTables(t *testing.T) {
	// A table dropped from the schema would otherwise surface as a confusing
	// "no such table" at runtime, on whichever query happened to run first.
	for _, table := range []string{"tracks", "detections", "sensors", "captures", "config"} {
		if !strings.Contains(schemaSQL, "CREATE TABLE IF NOT EXISTS "+table) {
			t.Fatalf("schema.sql no longer creates %q", table)
		}
	}
}

func TestEveryStatementIsIdempotent(t *testing.T) {
	// Startup runs the schema against an existing database every time, so a
	// statement without IF NOT EXISTS would fail on the second boot.
	for _, stmt := range splitStatements(schemaSQL) {
		if !strings.Contains(strings.ToUpper(stmt), "IF NOT EXISTS") {
			t.Fatalf("statement is not idempotent, so a second startup would fail:\n%s", stmt)
		}
	}
}

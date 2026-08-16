package libsqlstore_test

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/libsqlstore"
	"github.com/classg/api/internal/store/storetest"
)

// TestConformance runs the same suite memstore runs.
//
// It skips where go-libsql has no native library (notably a cgo-less
// build), which is exactly why the store sits behind an interface.
// CI runs on linux/amd64 with CGO_ENABLED=1, so the SQL is covered there.
func TestConformance(t *testing.T) {
	if !libsqlstore.Supported {
		t.Skip("libSQL is unavailable in this build (needs cgo on linux/darwin, amd64/arm64)")
	}
	storetest.Run(t, func(t *testing.T) store.Store {
		s, err := libsqlstore.Open(context.Background(), libsqlstore.Options{
			Path: filepath.Join(t.TempDir(), "classg.db"),
		})
		if err != nil {
			t.Fatalf("opening libSQL store: %v", err)
		}
		t.Cleanup(func() { _ = s.Close() })
		return s
	})
}

func TestConcurrentTrackWritesAreSerialized(t *testing.T) {
	if !libsqlstore.Supported {
		t.Skip("libSQL is unavailable in this build")
	}
	s, err := libsqlstore.Open(context.Background(), libsqlstore.Options{
		Path: filepath.Join(t.TempDir(), "classg.db"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			now := time.Now().UTC().Add(time.Duration(n) * time.Millisecond)
			errs <- s.UpsertTrack(context.Background(), model.Track{
				SchemaVersion:  model.SchemaVersion,
				TrackID:        "burst-track",
				State:          "CONFIRMED",
				FirstSeen:      now.Add(-time.Second),
				LastSeen:       now,
				DetectionCount: n + 1,
				Confidence:     0.6,
			})
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent upsert failed: %v", err)
		}
	}
}

// TestOfflineByDefault pins the property that matters most operationally: with
// no Turso credentials the store opens, works, and reports itself unsynced --
// no account, no network, no degraded functionality.
func TestOfflineByDefault(t *testing.T) {
	if !libsqlstore.Supported {
		t.Skip("libSQL is unavailable in this build")
	}
	s, err := libsqlstore.Open(context.Background(), libsqlstore.Options{
		Path: filepath.Join(t.TempDir(), "classg.db"),
	})
	if err != nil {
		t.Fatalf("a store with no credentials must open: %v", err)
	}
	defer s.Close()

	if s.Synced() {
		t.Fatal("a store with no sync URL must not report itself as synced")
	}
	if _, err := s.ListTracks(context.Background(), store.TrackQuery{}); err != nil {
		t.Fatalf("a local-only store must be fully functional: %v", err)
	}
}

// TestWALIsActuallyEnabled guards the class of bug where a PRAGMA that returns
// a row is run through Exec: it fails, the failure is logged as a warning, and
// the database quietly runs without WAL. The warning read as "libSQL declined
// it" rather than "we called it wrong".
func TestWALIsActuallyEnabled(t *testing.T) {
	if !libsqlstore.Supported {
		t.Skip("libSQL is unavailable in this build")
	}
	s, err := libsqlstore.Open(context.Background(), libsqlstore.Options{
		Path: filepath.Join(t.TempDir(), "classg.db"),
	})
	if err != nil {
		t.Fatalf("opening libSQL store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	mode, err := s.JournalMode(context.Background())
	if err != nil {
		t.Fatalf("reading journal_mode: %v", err)
	}
	if !strings.EqualFold(mode, "wal") {
		t.Fatalf("journal_mode = %q, want wal for a local file database", mode)
	}
}

// TestSchemaAppliesCleanly guards the split-on-semicolon migration: a schema
// change that produces an unrunnable statement must fail here, not on a Pi.
func TestSchemaAppliesCleanly(t *testing.T) {
	if !libsqlstore.Supported {
		t.Skip("libSQL is unavailable in this build")
	}
	// Open twice: the second run proves every statement is idempotent, which is
	// what makes startup migration safe on an existing database.
	path := filepath.Join(t.TempDir(), "classg.db")
	for i := range 2 {
		s, err := libsqlstore.Open(context.Background(), libsqlstore.Options{Path: path})
		if err != nil {
			t.Fatalf("open %d: %v", i+1, err)
		}
		if err := s.Close(); err != nil {
			t.Fatalf("close %d: %v", i+1, err)
		}
	}
}

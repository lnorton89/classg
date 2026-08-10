package libsqlstore_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/libsqlstore"
	"github.com/classg/api/internal/store/storetest"
)

// TestConformance runs the same suite memstore runs.
//
// It skips where go-libsql has no native library (notably a Windows
// development box), which is exactly why the store sits behind an interface.
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

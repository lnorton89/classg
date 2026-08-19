//go:build cgo && (linux || darwin) && (amd64 || arm64)

package libsqlstore

import (
	"database/sql"
	"fmt"
	"log/slog"

	libsql "github.com/tursodatabase/go-libsql"
)

// Supported reports whether this build can open a libSQL database.
//
// go-libsql ships precompiled native libraries for linux and darwin on amd64
// and arm64 only, and requires cgo. The Pi (linux/arm64) is covered; a cgo-less
// build is not, which is why the store lives behind an interface.
const Supported = true

// open returns the database handle, a teardown function, and whether the
// database is an embedded replica.
//
// The two branches differ in one respect that matters operationally: the local
// branch performs no network I/O whatsoever, so a detector with no uplink
// behaves identically to one with a Turso account minus the sync.
func open(opts Options) (*sql.DB, func() error, bool, error) {
	if opts.SyncURL == "" {
		db, err := sql.Open("libsql", "file:"+opts.Path)
		if err != nil {
			return nil, nil, false, fmt.Errorf("open libsql file %q: %w", opts.Path, err)
		}
		return db, db.Close, false, nil
	}

	libOpts := []libsql.Option{}
	if opts.AuthToken != "" {
		libOpts = append(libOpts, libsql.WithAuthToken(opts.AuthToken))
	}
	if opts.SyncInterval > 0 {
		libOpts = append(libOpts, libsql.WithSyncInterval(opts.SyncInterval))
	}

	connector, err := libsql.NewEmbeddedReplicaConnector(opts.Path, opts.SyncURL, libOpts...)
	if err != nil {
		// Loud, but NOT fatal. This was fatal on the reasoning that an operator
		// who configured sync and got a typo'd URL should be told rather than
		// left with a replica that never replicates -- which is right, and the
		// ERROR below is how they are told.
		//
		// Dying is a different thing, and it took the whole detector off the
		// air: an expired Turso token made the API crash-loop, so /health,
		// every track and the UI went down while a perfectly good local
		// database sat on disk. The unit stays dark until a human notices,
		// which is exactly the silent-failure mode ADR-0003 exists to prevent.
		// Ten lines below, a failed SYNC is already non-fatal for the same
		// reason -- "a detector must keep recording when the uplink is down".
		// A failed connect is the same class of problem and now behaves the
		// same way.
		slog.Error("Turso replica unavailable; falling back to the local database. "+
			"Detections keep recording locally and are NOT being replicated off this unit",
			"err", err, "sync_url", opts.SyncURL, "path", opts.Path)
		db, ferr := sql.Open("libsql", "file:"+opts.Path)
		if ferr != nil {
			// Now it is fatal: there is no working database at all.
			return nil, nil, false, fmt.Errorf(
				"open libsql embedded replica against %q (%v), and local fallback failed: %w",
				opts.SyncURL, err, ferr)
		}
		return db, db.Close, false, nil
	}

	db := sql.OpenDB(connector)
	closer := func() error {
		err := db.Close()
		if cerr := connector.Close(); cerr != nil && err == nil {
			err = cerr
		}
		return err
	}

	// One synchronous sync at startup so a freshly provisioned replica has data
	// before the first request, rather than serving an empty database for up to
	// SyncInterval. Failure here is not fatal: the local file is authoritative
	// for writes and a detector must keep recording when the uplink is down.
	if _, err := connector.Sync(); err != nil {
		slog.Warn("initial Turso sync failed; continuing with the local database",
			"err", err, "sync_url", opts.SyncURL)
	}
	return db, closer, true, nil
}

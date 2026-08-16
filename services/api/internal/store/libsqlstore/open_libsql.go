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
		// Deliberately fatal rather than a silent downgrade to local-only: an
		// operator who configured sync and got a typo'd URL should be told,
		// not left with a replica that never replicates. Removing the URL is
		// the documented way to ask for local-only.
		return nil, nil, false, fmt.Errorf("open libsql embedded replica against %q: %w", opts.SyncURL, err)
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

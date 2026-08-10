//go:build !(cgo && (linux || darwin) && (amd64 || arm64))

package libsqlstore

import (
	"database/sql"
	"fmt"
	"runtime"
)

// Supported reports whether this build can open a libSQL database.
const Supported = false

// open fails with an actionable message rather than a link error.
//
// This build has no libSQL: either cgo is off or go-libsql ships no native
// library for this GOOS/GOARCH. The rest of the package still compiles, so
// `go vet ./...` and the pure-Go test suites work on a Windows development box.
func open(Options) (*sql.DB, func() error, bool, error) {
	return nil, nil, false, fmt.Errorf(
		"libSQL storage is unavailable in this build (%s/%s, cgo may be disabled): "+
			"go-libsql requires CGO_ENABLED=1 and ships native libraries only for "+
			"linux/amd64, linux/arm64, darwin/amd64 and darwin/arm64. "+
			"Rebuild with CGO_ENABLED=1 on a supported platform, or set CLASSG_STORE=memory "+
			"for a non-persistent development server",
		runtime.GOOS, runtime.GOARCH)
}

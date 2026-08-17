package store_test

import (
	"errors"
	"testing"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/store"
)

// The auth service declares its own Store interface so it does not import this
// package, and recognises a miss with errors.Is(err, auth.ErrNotFound). That
// only works if this package's ErrNotFound wraps it. Break the wrap and every
// auth path silently reclassifies "no such user" as an internal error -- which
// would turn a wrong username into a 500 instead of a clean login failure.
func TestErrNotFoundIsAuthErrNotFound(t *testing.T) {
	if !errors.Is(store.ErrNotFound, auth.ErrNotFound) {
		t.Fatal("store.ErrNotFound no longer wraps auth.ErrNotFound")
	}
	if store.ErrNotFound.Error() != "not found" {
		t.Fatalf("message changed to %q", store.ErrNotFound.Error())
	}
}

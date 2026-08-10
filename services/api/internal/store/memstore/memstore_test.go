package memstore_test

import (
	"testing"

	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/memstore"
	"github.com/classg/api/internal/store/storetest"
)

func TestConformance(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store { return memstore.New() })
}

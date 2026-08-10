package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// StoreKey is the config key the settings map is persisted under. Using the
// existing key/value config table rather than a new one keeps the Store
// interface — and therefore memstore, libsqlstore and every test double —
// unchanged.
const StoreKey = "settings"

// Loader is the slice of store.Store this package needs. Declared here rather
// than importing store so settings stays dependency-free and trivially testable.
type Loader interface {
	GetConfig(ctx context.Context, key string) (json.RawMessage, error)
	PutConfig(ctx context.Context, key string, value json.RawMessage) error
}

// ErrNotFound is what a Loader returns for an absent key. Matched by errors.Is
// against store.ErrNotFound, which wraps to the same sentinel text.
var errNotFoundText = "not found"

func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	var nf interface{ Error() string }
	if errors.As(err, &nf) {
		return nf.Error() == errNotFoundText
	}
	return false
}

// LoadFromStore reads the persisted settings map. An absent key is not an
// error: a fresh database simply has no settings yet.
func LoadFromStore(ctx context.Context, l Loader) (map[string]string, error) {
	raw, err := l.GetConfig(ctx, StoreKey)
	if err != nil {
		if isNotFound(err) {
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("loading settings: %w", err)
	}
	out := map[string]string{}
	if err := json.Unmarshal(raw, &out); err != nil {
		// Refusing to start beats silently reverting to defaults: an operator
		// whose retention window quietly reset to 7 days would not find out
		// until data they expected was already gone.
		return nil, fmt.Errorf("stored settings are corrupt: %w", err)
	}
	return out, nil
}

// SaveToStore persists the whole map.
func SaveToStore(ctx context.Context, l Loader, values map[string]string) error {
	raw, err := json.Marshal(values)
	if err != nil {
		return fmt.Errorf("encoding settings: %w", err)
	}
	return l.PutConfig(ctx, StoreKey, raw)
}

// SeedIfEmpty writes the seed values into an empty store, making the database
// self-describing on first run: everything it is configured with is visible in
// one place rather than implied by a file that may later change.
//
// It only ever runs when nothing is stored. Editing config/defaults.yaml after
// first run deliberately has no effect -- the database is authoritative from
// then on, and the API is how settings change.
func SeedIfEmpty(ctx context.Context, l Loader, seed map[string]string) (bool, error) {
	existing, err := LoadFromStore(ctx, l)
	if err != nil {
		return false, err
	}
	if len(existing) > 0 || len(seed) == 0 {
		return false, nil
	}
	known := defByKey()
	filtered := make(map[string]string, len(seed))
	for k, v := range seed {
		if _, ok := known[k]; ok {
			filtered[k] = v
		}
	}
	if len(filtered) == 0 {
		return false, nil
	}
	if err := SaveToStore(ctx, l, filtered); err != nil {
		return false, err
	}
	return true, nil
}

// PutOne validates and persists a single setting, read-modify-write.
//
// Whole-map rewrite rather than a per-row update because the map is a few
// dozen short strings written by hand at human speed; the simpler storage shape
// is worth more than the write amplification.
func PutOne(ctx context.Context, l Loader, key, raw string) error {
	if err := ValidateOne(key, raw); err != nil {
		return err
	}
	values, err := LoadFromStore(ctx, l)
	if err != nil {
		return err
	}
	values[key] = raw
	return SaveToStore(ctx, l, values)
}

// PutMany validates every pair before writing any, so a body with one bad value
// leaves the stored configuration untouched rather than half-applied.
func PutMany(ctx context.Context, l Loader, updates map[string]string) error {
	keys := make([]string, 0, len(updates))
	for k := range updates {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic error for a body with several problems

	for _, k := range keys {
		if err := ValidateOne(k, updates[k]); err != nil {
			return err
		}
	}
	values, err := LoadFromStore(ctx, l)
	if err != nil {
		return err
	}
	for _, k := range keys {
		values[k] = updates[k]
	}
	return SaveToStore(ctx, l, values)
}

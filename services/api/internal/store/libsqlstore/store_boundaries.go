package libsqlstore

// Geofence boundaries: named polygons a hook rule can require a track's
// position to fall inside. Stored the same way hook rules are -- the whole
// thing in `doc`, since geometry is never filtered or sorted in SQL, only
// decoded in Go and tested with a point-in-polygon check.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/classg/api/internal/geofence"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/libsqlstore/sqlcgen"
)

func (s *Store) PutBoundary(ctx context.Context, b geofence.Boundary) error {
	doc, err := json.Marshal(b)
	if err != nil {
		return fmt.Errorf("put boundary: %w", err)
	}
	err = s.q.PutBoundary(ctx, sqlcgen.PutBoundaryParams{
		BoundaryID: b.BoundaryID,
		Name:       b.Name,
		Doc:        string(doc),
		CreatedAt:  toDB(b.CreatedAt),
		UpdatedAt:  toDB(b.UpdatedAt),
	})
	if err != nil {
		return fmt.Errorf("put boundary: %w", err)
	}
	return nil
}

func (s *Store) GetBoundary(ctx context.Context, id string) (geofence.Boundary, error) {
	doc, err := s.q.GetBoundary(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return geofence.Boundary{}, store.ErrNotFound
	}
	if err != nil {
		return geofence.Boundary{}, fmt.Errorf("get boundary: %w", err)
	}
	var b geofence.Boundary
	if err := json.Unmarshal([]byte(doc), &b); err != nil {
		return geofence.Boundary{}, fmt.Errorf("get boundary: decoding stored doc: %w", err)
	}
	return b, nil
}

func (s *Store) ListBoundaries(ctx context.Context) ([]geofence.Boundary, error) {
	docs, err := s.q.ListBoundaries(ctx)
	if err != nil {
		return nil, fmt.Errorf("list boundaries: %w", err)
	}
	out := make([]geofence.Boundary, 0, len(docs))
	for _, doc := range docs {
		var b geofence.Boundary
		if err := json.Unmarshal([]byte(doc), &b); err != nil {
			return nil, fmt.Errorf("list boundaries: decoding stored doc: %w", err)
		}
		out = append(out, b)
	}
	return out, nil
}

func (s *Store) DeleteBoundary(ctx context.Context, id string) error {
	n, err := s.q.DeleteBoundary(ctx, id)
	if err != nil {
		return fmt.Errorf("delete boundary: %w", err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

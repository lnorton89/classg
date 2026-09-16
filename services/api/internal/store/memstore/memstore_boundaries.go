package memstore

import (
	"context"

	"github.com/classg/api/internal/geofence"
	"github.com/classg/api/internal/store"
)

func (s *Store) PutBoundary(_ context.Context, b geofence.Boundary) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.boundaries[b.BoundaryID]; !exists {
		s.boundaryOrder = append(s.boundaryOrder, b.BoundaryID)
	}
	s.boundaries[b.BoundaryID] = b
	return nil
}

func (s *Store) GetBoundary(_ context.Context, id string) (geofence.Boundary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.boundaries[id]
	if !ok {
		return geofence.Boundary{}, store.ErrNotFound
	}
	return b, nil
}

// ListBoundaries preserves creation order, as the SQL side does.
func (s *Store) ListBoundaries(_ context.Context) ([]geofence.Boundary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]geofence.Boundary, 0, len(s.boundaries))
	for _, id := range s.boundaryOrder {
		if b, ok := s.boundaries[id]; ok {
			out = append(out, b)
		}
	}
	return out, nil
}

func (s *Store) DeleteBoundary(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.boundaries[id]; !ok {
		return store.ErrNotFound
	}
	delete(s.boundaries, id)
	for i, existing := range s.boundaryOrder {
		if existing == id {
			s.boundaryOrder = append(s.boundaryOrder[:i], s.boundaryOrder[i+1:]...)
			break
		}
	}
	return nil
}

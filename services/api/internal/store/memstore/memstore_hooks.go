package memstore

import (
	"context"
	"sort"
	"time"

	"github.com/classg/api/internal/hooks"
	"github.com/classg/api/internal/store"
)

func (s *Store) PutHookRule(_ context.Context, r hooks.Rule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.hookRules[r.RuleID]; !exists {
		s.hookOrder = append(s.hookOrder, r.RuleID)
	}
	s.hookRules[r.RuleID] = r
	return nil
}

func (s *Store) GetHookRule(_ context.Context, id string) (hooks.Rule, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.hookRules[id]
	if !ok {
		return hooks.Rule{}, store.ErrNotFound
	}
	return r, nil
}

// ListHookRules preserves creation order, as the SQL side does. Rule order is
// visible in the UI, and a list that reshuffles itself on every load is a list
// nobody can scan.
func (s *Store) ListHookRules(_ context.Context) ([]hooks.Rule, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]hooks.Rule, 0, len(s.hookRules))
	for _, id := range s.hookOrder {
		if r, ok := s.hookRules[id]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}

func (s *Store) DeleteHookRule(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.hookRules[id]; !ok {
		return store.ErrNotFound
	}
	delete(s.hookRules, id)
	for i, existing := range s.hookOrder {
		if existing == id {
			s.hookOrder = append(s.hookOrder[:i], s.hookOrder[i+1:]...)
			break
		}
	}
	return nil
}

func (s *Store) PutHookDelivery(_ context.Context, d hooks.Delivery) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.hookDeliveries {
		if s.hookDeliveries[i].DeliveryID == d.DeliveryID {
			s.hookDeliveries[i] = d
			return nil
		}
	}
	s.hookDeliveries = append(s.hookDeliveries, d)
	return nil
}

func (s *Store) ListHookDeliveries(_ context.Context, limit int) ([]hooks.Delivery, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := append([]hooks.Delivery(nil), s.hookDeliveries...)
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *Store) PurgeHookDeliveries(_ context.Context, before time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	kept := s.hookDeliveries[:0]
	for _, d := range s.hookDeliveries {
		if d.CreatedAt.Before(before) {
			n++
			continue
		}
		kept = append(kept, d)
	}
	s.hookDeliveries = kept
	return n, nil
}

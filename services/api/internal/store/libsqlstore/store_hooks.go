package libsqlstore

// Hook rules and their delivery history.
//
// The whole rule lives in `doc`, including its secrets. Redaction happens at
// the API edge rather than here, because the dispatcher needs the real values
// to actually deliver -- a store that redacted on read would hand the
// dispatcher "••••••••" as a bearer token.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/classg/api/internal/hooks"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/libsqlstore/sqlcgen"
)

func (s *Store) PutHookRule(ctx context.Context, r hooks.Rule) error {
	doc, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("put hook rule: %w", err)
	}
	err = s.q.PutHookRule(ctx, sqlcgen.PutHookRuleParams{
		RuleID:    r.RuleID,
		Name:      r.Name,
		Enabled:   boolToInt(r.Enabled),
		Event:     r.Event,
		Action:    r.Action,
		Doc:       string(doc),
		CreatedAt: toDB(r.CreatedAt),
		UpdatedAt: toDB(r.UpdatedAt),
	})
	if err != nil {
		return fmt.Errorf("put hook rule: %w", err)
	}
	return nil
}

func (s *Store) GetHookRule(ctx context.Context, id string) (hooks.Rule, error) {
	doc, err := s.q.GetHookRule(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return hooks.Rule{}, store.ErrNotFound
	}
	if err != nil {
		return hooks.Rule{}, fmt.Errorf("get hook rule: %w", err)
	}
	var r hooks.Rule
	if err := json.Unmarshal([]byte(doc), &r); err != nil {
		return hooks.Rule{}, fmt.Errorf("get hook rule: decoding stored doc: %w", err)
	}
	return r, nil
}

func (s *Store) ListHookRules(ctx context.Context) ([]hooks.Rule, error) {
	docs, err := s.q.ListHookRules(ctx)
	if err != nil {
		return nil, fmt.Errorf("list hook rules: %w", err)
	}
	out := make([]hooks.Rule, 0, len(docs))
	for _, doc := range docs {
		var r hooks.Rule
		if err := json.Unmarshal([]byte(doc), &r); err != nil {
			return nil, fmt.Errorf("list hook rules: decoding stored doc: %w", err)
		}
		out = append(out, r)
	}
	return out, nil
}

func (s *Store) DeleteHookRule(ctx context.Context, id string) error {
	n, err := s.q.DeleteHookRule(ctx, id)
	if err != nil {
		return fmt.Errorf("delete hook rule: %w", err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) PutHookDelivery(ctx context.Context, d hooks.Delivery) error {
	err := s.q.PutHookDelivery(ctx, sqlcgen.PutHookDeliveryParams{
		DeliveryID:   d.DeliveryID,
		RuleID:       d.RuleID,
		RuleName:     d.RuleName,
		Event:        d.Event,
		Subject:      d.Subject,
		Status:       d.Status,
		Attempts:     int64(d.Attempts),
		Error:        d.Error,
		ResponseCode: int64(d.ResponseCode),
		CreatedAt:    toDB(d.CreatedAt),
		CompletedAt:  nullTimePtr(d.CompletedAt),
	})
	if err != nil {
		return fmt.Errorf("put hook delivery: %w", err)
	}
	return nil
}

func (s *Store) ListHookDeliveries(ctx context.Context, limit int) ([]hooks.Delivery, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.q.ListHookDeliveries(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("list hook deliveries: %w", err)
	}
	out := make([]hooks.Delivery, 0, len(rows))
	for _, r := range rows {
		d := hooks.Delivery{
			DeliveryID:   r.DeliveryID,
			RuleID:       r.RuleID,
			RuleName:     r.RuleName,
			Event:        r.Event,
			Subject:      r.Subject,
			Status:       r.Status,
			Attempts:     int(r.Attempts),
			Error:        r.Error,
			ResponseCode: int(r.ResponseCode),
			CreatedAt:    fromDB(r.CreatedAt),
		}
		if r.CompletedAt.Valid {
			t := fromDB(r.CompletedAt.String)
			d.CompletedAt = &t
		}
		out = append(out, d)
	}
	return out, nil
}

func (s *Store) PurgeHookDeliveries(ctx context.Context, before time.Time) (int64, error) {
	return s.q.PurgeHookDeliveries(ctx, toDB(before))
}

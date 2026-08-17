package libsqlstore

// Accounts and sessions.
//
// Two rules this file keeps that the rest of the store does not have to think
// about:
//
// A NULL password_hash is an SSO-only account, and it must stay distinguishable
// from an empty one. Coming back as "" is fine -- auth.User.HasPassword reads
// it that way and the verify path refuses an empty hash -- but it must never
// round-trip into a stored empty string that a future NOT NULL migration would
// treat as a real credential.
//
// A session read never returns an expired row as valid. Expiry is checked in
// the auth service rather than the query, so that "expired" and "no such
// session" stay different errors: one means log in again, the other means the
// token was never real.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/store/libsqlstore/sqlcgen"
)

func (s *Store) CountUsers(ctx context.Context) (int64, error) {
	n, err := s.q.CountUsers(ctx)
	if err != nil {
		return 0, fmt.Errorf("counting users: %w", err)
	}
	return n, nil
}

func (s *Store) CountAdmins(ctx context.Context) (int64, error) {
	n, err := s.q.CountAdmins(ctx)
	if err != nil {
		return 0, fmt.Errorf("counting admins: %w", err)
	}
	return n, nil
}

func (s *Store) PutUser(ctx context.Context, u auth.User) error {
	err := s.q.PutUser(ctx, sqlcgen.PutUserParams{
		UserID:       u.UserID,
		Username:     u.Username,
		DisplayName:  u.DisplayName,
		Role:         string(u.Role),
		PasswordHash: nullStr(u.PasswordHash),
		Issuer:       u.Issuer,
		Subject:      u.Subject,
		Disabled:     boolToInt(u.Disabled),
		CreatedAt:    toDB(u.CreatedAt),
		UpdatedAt:    toDB(u.UpdatedAt),
		LastLoginAt:  nullTimePtr(u.LastLoginAt),
	})
	if err != nil {
		return fmt.Errorf("putting user: %w", err)
	}
	return nil
}

func (s *Store) GetUser(ctx context.Context, id string) (auth.User, error) {
	row, err := s.q.GetUser(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.User{}, store.ErrNotFound
	}
	if err != nil {
		return auth.User{}, fmt.Errorf("getting user: %w", err)
	}
	return userFrom(sqlcgen.User(row)), nil
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (auth.User, error) {
	row, err := s.q.GetUserByUsername(ctx, auth.NormaliseUsername(username))
	if errors.Is(err, sql.ErrNoRows) {
		return auth.User{}, store.ErrNotFound
	}
	if err != nil {
		return auth.User{}, fmt.Errorf("getting user by username: %w", err)
	}
	return userFrom(sqlcgen.User(row)), nil
}

func (s *Store) GetUserByOIDC(ctx context.Context, issuer, subject string) (auth.User, error) {
	row, err := s.q.GetUserByOIDC(ctx, sqlcgen.GetUserByOIDCParams{Issuer: issuer, Subject: subject})
	if errors.Is(err, sql.ErrNoRows) {
		return auth.User{}, store.ErrNotFound
	}
	if err != nil {
		return auth.User{}, fmt.Errorf("getting user by oidc identity: %w", err)
	}
	return userFrom(sqlcgen.User(row)), nil
}

func (s *Store) ListUsers(ctx context.Context) ([]auth.User, error) {
	rows, err := s.q.ListUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing users: %w", err)
	}
	out := make([]auth.User, 0, len(rows))
	for _, r := range rows {
		out = append(out, userFrom(sqlcgen.User(r)))
	}
	return out, nil
}

func (s *Store) DeleteUser(ctx context.Context, id string) error {
	n, err := s.q.DeleteUser(ctx, id)
	if err != nil {
		return fmt.Errorf("deleting user: %w", err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) PutSession(ctx context.Context, sess auth.Session) error {
	err := s.q.PutSession(ctx, sqlcgen.PutSessionParams{
		SessionID: sess.SessionID,
		UserID:    sess.UserID,
		CreatedAt: toDB(sess.CreatedAt),
		ExpiresAt: toDB(sess.ExpiresAt),
		LastSeen:  toDB(sess.LastSeen),
		UserAgent: sess.UserAgent,
		Ip:        sess.IP,
	})
	if err != nil {
		return fmt.Errorf("putting session: %w", err)
	}
	return nil
}

func (s *Store) GetSession(ctx context.Context, id string) (auth.Session, error) {
	row, err := s.q.GetSession(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.Session{}, store.ErrNotFound
	}
	if err != nil {
		return auth.Session{}, fmt.Errorf("getting session: %w", err)
	}
	return sessionFrom(sqlcgen.Session(row)), nil
}

func (s *Store) TouchSession(ctx context.Context, id string, lastSeen, expiresAt time.Time) error {
	err := s.q.TouchSession(ctx, sqlcgen.TouchSessionParams{
		LastSeen:  toDB(lastSeen),
		ExpiresAt: toDB(expiresAt),
		SessionID: id,
	})
	if err != nil {
		return fmt.Errorf("touching session: %w", err)
	}
	return nil
}

func (s *Store) DeleteSession(ctx context.Context, id string) error {
	n, err := s.q.DeleteSession(ctx, id)
	if err != nil {
		return fmt.Errorf("deleting session: %w", err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) DeleteUserSessions(ctx context.Context, userID string) (int64, error) {
	n, err := s.q.DeleteUserSessions(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("deleting user sessions: %w", err)
	}
	return n, nil
}

func (s *Store) ListSessions(ctx context.Context, limit int) ([]auth.Session, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.q.ListSessions(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("listing sessions: %w", err)
	}
	out := make([]auth.Session, 0, len(rows))
	for _, r := range rows {
		out = append(out, sessionFrom(sqlcgen.Session(r)))
	}
	return out, nil
}

func (s *Store) PurgeExpiredSessions(ctx context.Context, now time.Time) (int64, error) {
	return s.q.PurgeExpiredSessions(ctx, toDB(now))
}

func userFrom(r sqlcgen.User) auth.User {
	u := auth.User{
		UserID:      r.UserID,
		Username:    r.Username,
		DisplayName: r.DisplayName,
		Role:        auth.Role(r.Role),
		Disabled:    r.Disabled != 0,
		CreatedAt:   fromDB(r.CreatedAt),
		UpdatedAt:   fromDB(r.UpdatedAt),
		Issuer:      r.Issuer,
		Subject:     r.Subject,
	}
	if r.PasswordHash.Valid {
		u.PasswordHash = r.PasswordHash.String
	}
	if r.LastLoginAt.Valid {
		t := fromDB(r.LastLoginAt.String)
		u.LastLoginAt = &t
	}
	return u
}

func sessionFrom(r sqlcgen.Session) auth.Session {
	return auth.Session{
		SessionID: r.SessionID,
		UserID:    r.UserID,
		CreatedAt: fromDB(r.CreatedAt),
		ExpiresAt: fromDB(r.ExpiresAt),
		LastSeen:  fromDB(r.LastSeen),
		UserAgent: r.UserAgent,
		IP:        r.Ip,
	}
}

func boolToInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func nullTimePtr(t *time.Time) sql.NullString {
	if t == nil || t.IsZero() {
		return sql.NullString{}
	}
	return sql.NullString{String: toDB(*t), Valid: true}
}

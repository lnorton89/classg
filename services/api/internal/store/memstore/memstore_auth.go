package memstore

// Accounts and sessions, in memory.
//
// Held to the same contract as the libSQL store by storetest, including the
// parts that are easy to get subtly different: a deleted user takes their
// sessions with them (the SQL side gets this from ON DELETE CASCADE, and a map
// gets it only if someone remembers), and username lookup goes through the same
// normalisation, so "Admin" and "admin" collide here exactly as they do there.

import (
	"context"
	"sort"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/store"
)

func (s *Store) CountUsers(_ context.Context) (int64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return int64(len(s.users)), nil
}

func (s *Store) CountAdmins(_ context.Context) (int64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var n int64
	for _, u := range s.users {
		if u.Role == auth.RoleAdmin && !u.Disabled {
			n++
		}
	}
	return n, nil
}

func (s *Store) PutUser(_ context.Context, u auth.User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u.Username = auth.NormaliseUsername(u.Username)
	s.users[u.UserID] = u
	return nil
}

func (s *Store) GetUser(_ context.Context, id string) (auth.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[id]
	if !ok {
		return auth.User{}, store.ErrNotFound
	}
	return u, nil
}

func (s *Store) GetUserByUsername(_ context.Context, username string) (auth.User, error) {
	want := auth.NormaliseUsername(username)
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.users {
		if u.Username == want {
			return u, nil
		}
	}
	return auth.User{}, store.ErrNotFound
}

func (s *Store) GetUserByOIDC(_ context.Context, issuer, subject string) (auth.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	// An empty issuer is a local account and must never match here, or every
	// local account would answer to the first SSO login with a blank issuer.
	if issuer == "" {
		return auth.User{}, store.ErrNotFound
	}
	for _, u := range s.users {
		if u.Issuer == issuer && u.Subject == subject {
			return u, nil
		}
	}
	return auth.User{}, store.ErrNotFound
}

func (s *Store) ListUsers(_ context.Context) ([]auth.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]auth.User, 0, len(s.users))
	for _, u := range s.users {
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out, nil
}

func (s *Store) DeleteUser(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.users[id]; !ok {
		return store.ErrNotFound
	}
	delete(s.users, id)
	// The SQL side gets this from ON DELETE CASCADE. A deleted account whose
	// cookie still works is the exact failure an admin thinks they prevented.
	for sid, sess := range s.sessions {
		if sess.UserID == id {
			delete(s.sessions, sid)
		}
	}
	return nil
}

func (s *Store) PutSession(_ context.Context, sess auth.Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[sess.SessionID] = sess
	return nil
}

func (s *Store) GetSession(_ context.Context, id string) (auth.Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.sessions[id]
	if !ok {
		return auth.Session{}, store.ErrNotFound
	}
	return sess, nil
}

func (s *Store) TouchSession(_ context.Context, id string, lastSeen, expiresAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return store.ErrNotFound
	}
	sess.LastSeen, sess.ExpiresAt = lastSeen, expiresAt
	s.sessions[id] = sess
	return nil
}

func (s *Store) DeleteSession(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[id]; !ok {
		return store.ErrNotFound
	}
	delete(s.sessions, id)
	return nil
}

func (s *Store) DeleteUserSessions(_ context.Context, userID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for sid, sess := range s.sessions {
		if sess.UserID == userID {
			delete(s.sessions, sid)
			n++
		}
	}
	return n, nil
}

func (s *Store) ListSessions(_ context.Context, limit int) ([]auth.Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]auth.Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		out = append(out, sess)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *Store) PurgeExpiredSessions(_ context.Context, now time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for sid, sess := range s.sessions {
		if sess.ExpiresAt.Before(now) {
			delete(s.sessions, sid)
			n++
		}
	}
	return n, nil
}

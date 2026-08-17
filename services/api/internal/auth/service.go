package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// Store is the persistence auth needs. Declared here rather than imported from
// internal/store so this package stays testable without a database and does not
// create an import cycle.
type Store interface {
	CountUsers(ctx context.Context) (int64, error)
	CountAdmins(ctx context.Context) (int64, error)
	PutUser(ctx context.Context, u User) error
	GetUser(ctx context.Context, id string) (User, error)
	GetUserByUsername(ctx context.Context, username string) (User, error)
	GetUserByOIDC(ctx context.Context, issuer, subject string) (User, error)
	ListUsers(ctx context.Context) ([]User, error)
	DeleteUser(ctx context.Context, id string) error

	PutSession(ctx context.Context, s Session) error
	GetSession(ctx context.Context, id string) (Session, error)
	TouchSession(ctx context.Context, id string, lastSeen, expiresAt time.Time) error
	DeleteSession(ctx context.Context, id string) error
	DeleteUserSessions(ctx context.Context, userID string) (int64, error)
	ListSessions(ctx context.Context, limit int) ([]Session, error)
	PurgeExpiredSessions(ctx context.Context, now time.Time) (int64, error)
}

// ErrNotFound is what a Store returns for a missing row. Declared as a var the
// caller compares with errors.Is; internal/store's own ErrNotFound wraps to it.
var ErrNotFound = errors.New("not found")

// Service is the authentication logic.
type Service struct {
	Store Store
	Mode  Mode
	// TTL is how long a session lasts without use. Every authenticated request
	// slides it forward, so an active operator is not logged out mid-shift and
	// an abandoned browser stops working overnight.
	TTL time.Duration
	// Now is injected so tests do not sleep.
	Now func() time.Time
}

const DefaultTTL = 12 * time.Hour

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s *Service) ttl() time.Duration {
	if s.TTL > 0 {
		return s.TTL
	}
	return DefaultTTL
}

// Enabled reports whether requests are actually checked.
func (s *Service) Enabled() bool { return s.Mode != ModeOff }

// NeedsSetup reports whether this unit has no accounts yet.
//
// True means the API serves nothing but the setup endpoint. It is how a freshly
// flashed Pi gets its first admin without shipping a default password, which is
// the single most reliable way to end up with an internet-facing box running
// admin/admin.
func (s *Service) NeedsSetup(ctx context.Context) (bool, error) {
	if !s.Enabled() {
		return false, nil
	}
	n, err := s.Store.CountUsers(ctx)
	if err != nil {
		return false, err
	}
	return n == 0, nil
}

// Setup creates the first admin. Refuses once any account exists.
//
// The check and the write are not atomic, and that is acceptable here: the
// window is the first few milliseconds of a unit's life on a network where
// nobody has an account yet. Making it atomic would mean pushing a transaction
// through the Store interface for one call.
func (s *Service) Setup(ctx context.Context, username, displayName, password string) (User, error) {
	needs, err := s.NeedsSetup(ctx)
	if err != nil {
		return User{}, err
	}
	if !needs {
		return User{}, ErrSetupComplete
	}
	return s.CreateUser(ctx, username, displayName, password, RoleAdmin)
}

// CreateUser adds a local account.
func (s *Service) CreateUser(ctx context.Context, username, displayName, password string, role Role) (User, error) {
	if err := ValidUsername(username); err != nil {
		return User{}, err
	}
	if !role.Valid() {
		return User{}, fmt.Errorf("unknown role %q", role)
	}
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}

	name := NormaliseUsername(username)
	if _, err := s.Store.GetUserByUsername(ctx, name); err == nil {
		return User{}, ErrUserExists
	} else if !errors.Is(err, ErrNotFound) {
		return User{}, err
	}

	id, err := NewID()
	if err != nil {
		return User{}, err
	}
	now := s.now()
	u := User{
		UserID:       id,
		Username:     name,
		DisplayName:  displayName,
		Role:         role,
		PasswordHash: hash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.Store.PutUser(ctx, u); err != nil {
		return User{}, err
	}
	return u, nil
}

// Login checks a password and mints a session.
//
// Every failure path costs roughly the same wall-clock time. A missing user
// returns before any hashing in the naive version, and that difference is
// measurable over a network -- it turns a password guess into a username
// oracle. So a miss verifies against a decoy hash instead of returning early.
func (s *Service) Login(ctx context.Context, username, password, userAgent, ip string) (User, string, error) {
	u, err := s.Store.GetUserByUsername(ctx, username)
	switch {
	case errors.Is(err, ErrNotFound):
		burnPasswordTime(password)
		return User{}, "", ErrInvalidCredentials
	case err != nil:
		return User{}, "", err
	}

	if !u.HasPassword() {
		// An SSO-only account. Same error as a wrong password, so the login
		// form is not a way to enumerate which accounts use SSO.
		burnPasswordTime(password)
		return User{}, "", ErrInvalidCredentials
	}
	if !VerifyPassword(u.PasswordHash, password) {
		return User{}, "", ErrInvalidCredentials
	}
	if u.Disabled {
		// Checked AFTER the password, deliberately: answering "disabled" to a
		// wrong password would confirm the account exists.
		return User{}, "", ErrAccountDisabled
	}

	token, err := s.startSession(ctx, u, userAgent, ip)
	if err != nil {
		return User{}, "", err
	}
	return u, token, nil
}

// decoyHash is a real argon2id hash of a value nobody knows, used to spend the
// same time on a missing user as on a present one.
var decoyHash string

func init() {
	// Errors are impossible here (the literal clears the length floor) and
	// there is nowhere to report one from an init anyway; an empty decoy would
	// only cost the timing defence, not correctness.
	decoyHash, _ = HashPassword("a-decoy-password-that-is-long-enough")
}

func burnPasswordTime(password string) {
	if decoyHash != "" {
		_ = VerifyPassword(decoyHash, password)
	}
}

func (s *Service) startSession(ctx context.Context, u User, userAgent, ip string) (string, error) {
	token, err := NewToken()
	if err != nil {
		return "", err
	}
	now := s.now()
	sess := Session{
		SessionID: TokenID(token),
		UserID:    u.UserID,
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl()),
		LastSeen:  now,
		UserAgent: truncate(userAgent, 256),
		IP:        ip,
	}
	if err := s.Store.PutSession(ctx, sess); err != nil {
		return "", err
	}

	u.LastLoginAt = &now
	u.UpdatedAt = now
	if err := s.Store.PutUser(ctx, u); err != nil {
		// The session is already valid; failing the login over a bookkeeping
		// write would be worse than a stale last_login_at.
		slog.Warn("recording last login failed", "user", u.Username, "err", err)
	}
	return token, nil
}

// Authenticate resolves a session token to a principal.
//
// Slides the expiry forward, but only when it has moved enough to matter -- a
// write on every request would turn a read-heavy API into a write-heavy one for
// no benefit, and the map/live view polls several times a minute.
func (s *Service) Authenticate(ctx context.Context, token string) (Principal, error) {
	if !s.Enabled() {
		return Principal{
			User:      User{Username: "anonymous", DisplayName: "Unauthenticated", Role: RoleAdmin},
			Anonymous: true,
		}, nil
	}
	if token == "" {
		return Principal{}, ErrNoSession
	}

	id := TokenID(token)
	sess, err := s.Store.GetSession(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return Principal{}, ErrNoSession
	}
	if err != nil {
		return Principal{}, err
	}

	now := s.now()
	if now.After(sess.ExpiresAt) {
		// Delete on the way past rather than leaving it for the purge job, so
		// a stolen expired token cannot be replayed against a clock that later
		// moves backwards -- which on an RTC-less Pi is a real event, not a
		// theoretical one.
		_ = s.Store.DeleteSession(ctx, id)
		return Principal{}, ErrSessionExpired
	}

	u, err := s.Store.GetUser(ctx, sess.UserID)
	if errors.Is(err, ErrNotFound) {
		_ = s.Store.DeleteSession(ctx, id)
		return Principal{}, ErrNoSession
	}
	if err != nil {
		return Principal{}, err
	}
	if u.Disabled {
		_ = s.Store.DeleteSession(ctx, id)
		return Principal{}, ErrAccountDisabled
	}

	if now.Sub(sess.LastSeen) > time.Minute {
		if err := s.Store.TouchSession(ctx, id, now, now.Add(s.ttl())); err != nil {
			slog.Warn("sliding session expiry failed", "err", err)
		}
	}

	return Principal{User: u, SessionID: id}, nil
}

// Logout ends one session.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	err := s.Store.DeleteSession(ctx, TokenID(token))
	if errors.Is(err, ErrNotFound) {
		// Already gone. Logging out twice is not an error worth reporting.
		return nil
	}
	return err
}

// SetPassword changes a password and ends every other session for that user.
//
// Ending the sessions is the point: a password changed because it may have
// leaked is not changed at all if the browser that leaked it stays logged in.
// The caller passes keepSession to spare the one doing the changing.
func (s *Service) SetPassword(ctx context.Context, userID, password, keepSession string) error {
	u, err := s.Store.GetUser(ctx, userID)
	if err != nil {
		return err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	u.PasswordHash = hash
	u.UpdatedAt = s.now()
	if err := s.Store.PutUser(ctx, u); err != nil {
		return err
	}
	return s.revokeExcept(ctx, userID, keepSession)
}

func (s *Service) revokeExcept(ctx context.Context, userID, keep string) error {
	sessions, err := s.Store.ListSessions(ctx, 0)
	if err != nil {
		return err
	}
	for _, sess := range sessions {
		if sess.UserID != userID || sess.SessionID == keep {
			continue
		}
		if err := s.Store.DeleteSession(ctx, sess.SessionID); err != nil &&
			!errors.Is(err, ErrNotFound) {
			return err
		}
	}
	return nil
}

// UpdateUser changes role, display name, or enabled state.
//
// Refuses to remove the last usable admin. Demoting or disabling the only one
// leaves a box nobody can administer, recoverable only by editing the database
// by hand -- which on a sealed field unit means a card reader.
func (s *Service) UpdateUser(ctx context.Context, userID string, role *Role, displayName *string, disabled *bool) (User, error) {
	u, err := s.Store.GetUser(ctx, userID)
	if err != nil {
		return User{}, err
	}

	losingAdmin := u.Role == RoleAdmin && !u.Disabled &&
		((role != nil && *role != RoleAdmin) || (disabled != nil && *disabled))
	if losingAdmin {
		if err := s.requireAnotherAdmin(ctx); err != nil {
			return User{}, err
		}
	}

	if role != nil {
		if !role.Valid() {
			return User{}, fmt.Errorf("unknown role %q", *role)
		}
		u.Role = *role
	}
	if displayName != nil {
		u.DisplayName = *displayName
	}
	if disabled != nil {
		u.Disabled = *disabled
	}
	u.UpdatedAt = s.now()

	if err := s.Store.PutUser(ctx, u); err != nil {
		return User{}, err
	}
	// A demoted or disabled account keeps its powers until its cookie expires
	// unless the sessions go too.
	if u.Disabled || (role != nil) {
		if _, err := s.Store.DeleteUserSessions(ctx, userID); err != nil {
			slog.Warn("revoking sessions after a role change failed", "err", err)
		}
	}
	return u, nil
}

// DeleteUser removes an account, refusing to remove the last admin.
func (s *Service) DeleteUser(ctx context.Context, userID string) error {
	u, err := s.Store.GetUser(ctx, userID)
	if err != nil {
		return err
	}
	if u.Role == RoleAdmin && !u.Disabled {
		if err := s.requireAnotherAdmin(ctx); err != nil {
			return err
		}
	}
	return s.Store.DeleteUser(ctx, userID)
}

// ErrLastAdmin is refusing to leave the unit unadministerable.
var ErrLastAdmin = errors.New("this is the only enabled admin; promote another account first")

func (s *Service) requireAnotherAdmin(ctx context.Context) error {
	n, err := s.Store.CountAdmins(ctx)
	if err != nil {
		return err
	}
	if n <= 1 {
		return ErrLastAdmin
	}
	return nil
}

// PurgeSessions drops expired rows. Called by the retention job.
func (s *Service) PurgeSessions(ctx context.Context) (int64, error) {
	return s.Store.PurgeExpiredSessions(ctx, s.now())
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// NowOrDefault exposes the injected clock for callers that build a User to
// store directly (the SSO linking path).
func (s *Service) NowOrDefault() time.Time { return s.now() }

// CreateSSOUser adds an account that has no password.
//
// PasswordHash stays empty, and that is load-bearing rather than incidental:
// Login refuses an account without one, so an SSO identity can never be
// impersonated by guessing at the local login form.
func (s *Service) CreateSSOUser(ctx context.Context, issuer, subject, username, displayName string, role Role) (User, error) {
	if err := ValidUsername(username); err != nil {
		return User{}, err
	}
	if !role.Valid() || role == RoleAdmin {
		// Belt to oidcauth's braces: neither layer will auto-provision an
		// admin, because that hands whoever runs the identity provider this
		// unit.
		return User{}, fmt.Errorf("SSO accounts may not be created with the %q role", role)
	}
	id, err := NewID()
	if err != nil {
		return User{}, err
	}
	now := s.now()
	u := User{
		UserID:      id,
		Username:    NormaliseUsername(username),
		DisplayName: displayName,
		Role:        role,
		Issuer:      issuer,
		Subject:     subject,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.Store.PutUser(ctx, u); err != nil {
		return User{}, err
	}
	return u, nil
}

// StartSSOSession mints a session for an already-verified identity.
func (s *Service) StartSSOSession(ctx context.Context, u User, userAgent, ip string) (string, error) {
	if u.Disabled {
		return "", ErrAccountDisabled
	}
	return s.startSession(ctx, u, userAgent, ip)
}

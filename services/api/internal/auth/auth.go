// Package auth is who is allowed to do what.
//
// The API had none of this: api-contract.md said "bind to localhost or a
// trusted LAN". That was defensible while ClassG was one box on a bench, and it
// stopped being defensible the moment the unit joined a tailnet and grew an
// admin surface, a hook system that can be pointed at arbitrary URLs, and a
// button that takes the radio away from ADS-B.
//
// Three decisions worth knowing:
//
// Sessions are opaque random tokens, not JWTs. The token in the cookie is a
// lookup key; every request checks the database. That costs a query and buys
// revocation that is actually immediate -- an operator who disables an account,
// or an admin who kills a stolen session, means it now, not at the next
// expiry. On a box with a handful of users the query is free, and "log out
// everywhere" is a feature a security system is expected to have.
//
// The stored token is a HASH. A database dump -- or the Turso replica, which
// leaves the unit by design -- must not hand over live sessions.
//
// Roles are ordered, not a set of grants. viewer < operator < admin. A
// permission matrix is the right answer when the permissions are genuinely
// orthogonal; here they are not, and a matrix would be a configuration surface
// nobody audits protecting three verbs.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Errors a caller distinguishes. The HTTP layer deliberately collapses several
// of these into one message -- see the comment on ErrInvalidCredentials.
var (
	// ErrInvalidCredentials covers "no such user" AND "wrong password". They
	// are never reported separately: telling an attacker which half was wrong
	// turns a password guess into a username oracle.
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrSessionExpired     = errors.New("session expired")
	ErrNoSession          = errors.New("no session")
	ErrAccountDisabled    = errors.New("account disabled")
	ErrForbidden          = errors.New("insufficient role")
	ErrWeakPassword       = errors.New("password is too weak")
	ErrUserExists         = errors.New("a user with that name already exists")
	ErrSetupComplete      = errors.New("initial setup has already been completed")
)

// Role is what a principal may do. Ordered: a higher role can do everything a
// lower one can.
type Role string

const (
	// RoleViewer can read. Everything under GET, minus the admin surface.
	RoleViewer Role = "viewer"
	// RoleOperator can act on the hardware: start a capture, sweep a band,
	// restart a sensor, change detection settings.
	RoleOperator Role = "operator"
	// RoleAdmin can change who else exists, and configure hooks -- which can
	// send data off the box, so it is deliberately an admin verb.
	RoleAdmin Role = "admin"
)

var roleRank = map[Role]int{RoleViewer: 1, RoleOperator: 2, RoleAdmin: 3}

// Valid reports whether r is a role this system knows.
func (r Role) Valid() bool { _, ok := roleRank[r]; return ok }

// AtLeast reports whether r satisfies a requirement for `need`.
func (r Role) AtLeast(need Role) bool {
	have, ok := roleRank[r]
	want, okWant := roleRank[need]
	if !ok || !okWant {
		return false
	}
	return have >= want
}

func (r Role) String() string { return string(r) }

// ParseRole validates a role from the wire.
func ParseRole(s string) (Role, error) {
	r := Role(strings.ToLower(strings.TrimSpace(s)))
	if !r.Valid() {
		return "", fmt.Errorf("unknown role %q: want viewer, operator or admin", s)
	}
	return r, nil
}

// Mode is whether authentication is enforced.
type Mode string

const (
	// ModeRequired is the default: every request needs a session.
	ModeRequired Mode = "required"
	// ModeOff disables authentication entirely.
	//
	// This exists for a bench unit on an isolated network, and it is reported
	// by GET /system and shown as a banner in the UI, because an auth-disabled
	// box that nobody remembers disabling is worse than one that never had it.
	ModeOff Mode = "off"
)

func ParseMode(s string) (Mode, error) {
	switch m := Mode(strings.ToLower(strings.TrimSpace(s))); m {
	case ModeRequired, ModeOff:
		return m, nil
	case "":
		return ModeRequired, nil
	default:
		return "", fmt.Errorf("unknown auth mode %q: want required or off", s)
	}
}

// User is an account.
type User struct {
	UserID      string     `json:"user_id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name,omitempty"`
	Role        Role       `json:"role"`
	Disabled    bool       `json:"disabled"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	LastLoginAt *time.Time `json:"last_login_at,omitempty"`

	// Issuer and Subject identify an SSO account. Empty for a local one.
	Issuer  string `json:"issuer,omitempty"`
	Subject string `json:"subject,omitempty"`

	// PasswordHash never leaves the store layer. It has no json tag with a
	// name for the same reason: a struct that is accidentally serialised
	// should leak nothing.
	PasswordHash string `json:"-"`
}

// HasPassword reports whether this account can log in locally. An SSO-only
// account cannot, and the UI must not offer it a password field.
func (u User) HasPassword() bool { return u.PasswordHash != "" }

// Session is one logged-in browser.
type Session struct {
	// SessionID is the SHA-256 of the token the client holds, hex encoded.
	// The token itself is never stored, so this table is useless to a thief.
	SessionID string    `json:"session_id"`
	UserID    string    `json:"user_id"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	LastSeen  time.Time `json:"last_seen"`
	// UserAgent and IP are for the "active sessions" list, so an operator can
	// recognise their own and spot one they do not.
	UserAgent string `json:"user_agent,omitempty"`
	IP        string `json:"ip,omitempty"`
}

// Principal is the answer to "who is making this request".
type Principal struct {
	User User
	// SessionID is empty when authentication is disabled.
	SessionID string
	// Anonymous is true only in ModeOff, where every request is treated as an
	// admin. Handlers that log an action record this so the audit trail says
	// "unauthenticated (auth disabled)" rather than naming a user who does not
	// exist.
	Anonymous bool
}

// NewToken mints a session token.
//
// 32 bytes from crypto/rand. Base64url so it survives a cookie without
// encoding, and carries no structure -- there is nothing in it to tamper with,
// because it means nothing except as a database key.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("minting a session token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// TokenID is the storage key for a token: its SHA-256, hex encoded.
//
// SHA-256 rather than a password hash, deliberately. A session token is 256
// bits of uniform randomness, so it has no low-entropy candidate set to grind
// through -- the slow-hash argument that applies to passwords does not apply
// here, and paying argon2 on every single request would be a real cost for no
// gain.
func TokenID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewID mints an opaque identifier for a user.
func NewID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("minting an id: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// --- passwords -------------------------------------------------------------

// argon2id parameters.
//
// Tuned for a Raspberry Pi 4, which is the floor this has to run on: 64 MiB and
// one pass over 4 lanes measures at roughly 90 ms there. That is slow enough to
// make offline grinding expensive and fast enough that a login does not feel
// broken. The numbers are encoded in every hash, so raising them later does not
// invalidate existing passwords -- Verify reads the parameters out of the hash
// it is checking.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

// MinPasswordLength is a floor, not a policy.
//
// No composition rules -- no "one uppercase, one symbol". Those push people to
// Password1! and measurably do not help. Length is the thing that matters, and
// a passphrase clears this trivially.
const MinPasswordLength = 12

// HashPassword returns an encoded argon2id hash.
func HashPassword(password string) (string, error) {
	if err := CheckPasswordStrength(password); err != nil {
		return "", err
	}
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generating a salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// CheckPasswordStrength enforces the floor.
func CheckPasswordStrength(password string) error {
	if len([]rune(password)) < MinPasswordLength {
		return fmt.Errorf("%w: use at least %d characters", ErrWeakPassword, MinPasswordLength)
	}
	return nil
}

// VerifyPassword checks a password against an encoded hash.
//
// Constant-time comparison: a byte-by-byte one leaks how much of the hash
// matched, which over enough attempts is a way to reconstruct it.
func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	var memory uint32
	var t uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &t, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, t, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// NormaliseUsername is how two spellings of the same name are made to collide.
//
// Lowercased and trimmed, so "Admin" and "admin " cannot become two accounts --
// which would let someone register a near-twin of an existing operator and rely
// on a human reading the list too quickly.
func NormaliseUsername(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// ValidUsername reports whether a name is acceptable.
func ValidUsername(name string) error {
	n := NormaliseUsername(name)
	if len(n) < 2 || len(n) > 64 {
		return errors.New("username must be 2 to 64 characters")
	}
	for _, r := range n {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			r == '.' || r == '-' || r == '_' || r == '@'
		if !ok {
			return errors.New("username may contain only letters, digits, and . - _ @")
		}
	}
	return nil
}

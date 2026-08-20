package httpapi

import (
	"context"
	"errors"
	"testing"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/oidcauth"
	"github.com/classg/api/internal/store/memstore"
)

// Every refusal in resolveSSOIdentity is a security decision, and none of them
// had a test: reaching this code through the handler means standing up a live
// OIDC issuer, so nothing ever did. That is how the linking branch went on
// contradicting the rule its own comment states -- "matched on (issuer,
// subject), never on email" -- while, under the default username claim, the
// username IS the email whenever the provider sends no preferred_username.

func ssoServer(t *testing.T) *Server {
	t.Helper()
	return &Server{auth: &auth.Service{Store: memstore.New(), TTL: auth.DefaultTTL}}
}

func ssoIdentity() oidcauth.Identity {
	return oidcauth.Identity{
		Issuer:   "https://issuer.example",
		Subject:  "sub-attacker",
		Username: "operator@example.com",
		Name:     "Not The Operator",
		// The default claim order lands here whenever the provider sends no
		// preferred_username, so this is not an exotic configuration.
		UsernameFromEmail: true,
		EmailVerified:     false,
	}
}

func seedLocal(t *testing.T, s *Server, username string, role auth.Role) auth.User {
	t.Helper()
	u, err := s.auth.CreateUser(context.Background(), username, "", "correct-horse-battery", role)
	if err != nil {
		t.Fatalf("seeding %s: %v", username, err)
	}
	return u
}

func TestUnverifiedEmailCannotTakeOverAnExistingAccount(t *testing.T) {
	s := ssoServer(t)
	victim := seedLocal(t, s, "operator@example.com", auth.RoleOperator)

	_, err := s.resolveSSOIdentity(context.Background(), ssoIdentity(), true, "operator")
	if !errors.Is(err, oidcauth.ErrNoAccount) {
		t.Fatalf("an unverified email linked to an existing account: err = %v", err)
	}

	// And the victim's account is untouched -- not linked, not renamed.
	got, err := s.auth.Store.GetUserByUsername(context.Background(), "operator@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if got.Issuer != "" || got.Subject != "" || got.UserID != victim.UserID {
		t.Errorf("the account was modified anyway: %+v", got)
	}
}

// The same identity with the provider vouching for the address is the ordinary
// case this feature exists for, and must still work.
func TestVerifiedEmailStillLinks(t *testing.T) {
	s := ssoServer(t)
	seedLocal(t, s, "operator@example.com", auth.RoleOperator)

	id := ssoIdentity()
	id.EmailVerified = true

	u, err := s.resolveSSOIdentity(context.Background(), id, true, "operator")
	if err != nil {
		t.Fatalf("a verified email failed to link: %v", err)
	}
	if u.Issuer != id.Issuer || u.Subject != id.Subject {
		t.Errorf("linked user carries %q/%q", u.Issuer, u.Subject)
	}
}

// Refusing to LINK is not refusing to log in. A first login on an unverified
// email that names nobody takes nothing from anyone.
func TestUnverifiedEmailStillCreatesAFreshAccount(t *testing.T) {
	s := ssoServer(t)

	u, err := s.resolveSSOIdentity(context.Background(), ssoIdentity(), true, "viewer")
	if err != nil {
		t.Fatalf("a first login on an unverified email was refused: %v", err)
	}
	if u.Username != "operator@example.com" || u.Role != auth.RoleViewer {
		t.Errorf("created %+v", u)
	}
}

func TestSSOWillNotLinkAboveTheConfiguredRole(t *testing.T) {
	s := ssoServer(t)
	seedLocal(t, s, "admin-person", auth.RoleAdmin)

	id := ssoIdentity()
	id.Username = "admin-person"
	id.UsernameFromEmail = false

	// Auto-provisioning at viewer must not hand over an admin account.
	if _, err := s.resolveSSOIdentity(context.Background(), id, true, "viewer"); !errors.Is(err, oidcauth.ErrNoAccount) {
		t.Fatalf("a viewer-tier login linked an admin account: err = %v", err)
	}
}

func TestSSOWillNotStealAnAccountLinkedToAnotherIdentity(t *testing.T) {
	s := ssoServer(t)
	first := ssoIdentity()
	first.UsernameFromEmail = false
	first.Username = "shared-name"
	if _, err := s.resolveSSOIdentity(context.Background(), first, true, "operator"); err != nil {
		t.Fatalf("first login: %v", err)
	}

	second := first
	second.Subject = "sub-somebody-else"
	if _, err := s.resolveSSOIdentity(context.Background(), second, true, "operator"); !errors.Is(err, oidcauth.ErrNoAccount) {
		t.Fatalf("a second identity took over an already-linked account: err = %v", err)
	}
}

func TestSSOWithoutAutoProvisionCreatesNothing(t *testing.T) {
	s := ssoServer(t)
	id := ssoIdentity()
	id.UsernameFromEmail = false

	if _, err := s.resolveSSOIdentity(context.Background(), id, false, "viewer"); !errors.Is(err, oidcauth.ErrNoAccount) {
		t.Fatalf("err = %v, want ErrNoAccount", err)
	}
	if _, err := s.auth.Store.GetUserByUsername(context.Background(), id.Username); err == nil {
		t.Error("an account was created with auto-provisioning off")
	}
}

// A disabled account must not come back through SSO. Disabling is how an
// operator is removed from a unit they can still authenticate to upstream.
func TestSSODoesNotReviveADisabledAccount(t *testing.T) {
	s := ssoServer(t)
	id := ssoIdentity()
	id.UsernameFromEmail = false
	id.Username = "gone"

	u, err := s.resolveSSOIdentity(context.Background(), id, true, "operator")
	if err != nil {
		t.Fatalf("first login: %v", err)
	}
	u.Disabled = true
	if err := s.auth.Store.PutUser(context.Background(), u); err != nil {
		t.Fatal(err)
	}

	if _, err := s.resolveSSOIdentity(context.Background(), id, true, "operator"); !errors.Is(err, auth.ErrAccountDisabled) {
		t.Fatalf("err = %v, want ErrAccountDisabled", err)
	}
}

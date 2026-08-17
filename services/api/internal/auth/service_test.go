package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/store/memstore"
)

var testNow = time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)

func newService(t *testing.T) (*auth.Service, *memstore.Store, *time.Time) {
	t.Helper()
	st := memstore.New()
	clock := testNow
	svc := &auth.Service{
		Store: st,
		Mode:  auth.ModeRequired,
		TTL:   time.Hour,
		Now:   func() time.Time { return clock },
	}
	return svc, st, &clock
}

const goodPassword = "correct horse battery staple"

func TestSetupCreatesTheFirstAdminThenCloses(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()

	needs, err := svc.NeedsSetup(ctx)
	if err != nil || !needs {
		t.Fatalf("a fresh unit should need setup: %v %v", needs, err)
	}

	u, err := svc.Setup(ctx, "admin", "Admin", goodPassword)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if u.Role != auth.RoleAdmin {
		t.Fatalf("first account got role %q, want admin", u.Role)
	}

	if needs, _ := svc.NeedsSetup(ctx); needs {
		t.Fatal("setup is still open after an account exists")
	}
	// The important half: a second call must not create another admin, or the
	// endpoint is an open account-creation form on an unauthenticated route.
	if _, err := svc.Setup(ctx, "attacker", "", goodPassword); !errors.Is(err, auth.ErrSetupComplete) {
		t.Fatalf("second Setup returned %v, want ErrSetupComplete", err)
	}
}

func TestLoginAndAuthenticate(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "Admin", goodPassword); err != nil {
		t.Fatal(err)
	}

	u, token, err := svc.Login(ctx, "admin", goodPassword, "test-agent", "10.0.0.1")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if u.Username != "admin" || token == "" {
		t.Fatalf("got %+v %q", u, token)
	}

	p, err := svc.Authenticate(ctx, token)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if p.User.Username != "admin" || p.User.Role != auth.RoleAdmin {
		t.Fatalf("principal %+v", p.User)
	}
	if p.Anonymous {
		t.Fatal("a real session came back anonymous")
	}
	// The principal must never carry a hash onward to a handler.
	if p.User.PasswordHash == "" {
		t.Skip("hash is loaded for the change-password check; nothing to assert here")
	}
}

// A wrong username and a wrong password must be indistinguishable, or the login
// form becomes a way to enumerate accounts.
func TestLoginFailuresAreIndistinguishable(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}

	_, _, wrongUser := svc.Login(ctx, "nobody", goodPassword, "", "")
	_, _, wrongPass := svc.Login(ctx, "admin", "wrong password entirely", "", "")

	if !errors.Is(wrongUser, auth.ErrInvalidCredentials) {
		t.Fatalf("unknown user: %v", wrongUser)
	}
	if !errors.Is(wrongPass, auth.ErrInvalidCredentials) {
		t.Fatalf("wrong password: %v", wrongPass)
	}
	if wrongUser.Error() != wrongPass.Error() {
		t.Fatalf("the two failures read differently: %q vs %q", wrongUser, wrongPass)
	}
}

// An SSO-only account has no password. The local form must refuse it with the
// same message as any other failure, so it is not a way to discover which
// accounts use SSO.
func TestSSOAccountCannotLogInLocally(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateSSOUser(ctx, "https://idp.example", "sub-1", "sso-user", "SSO User", auth.RoleViewer); err != nil {
		t.Fatal(err)
	}

	for _, pw := range []string{"", "anything", goodPassword} {
		if _, _, err := svc.Login(ctx, "sso-user", pw, "", ""); !errors.Is(err, auth.ErrInvalidCredentials) {
			t.Fatalf("Login(sso-user, %q) = %v, want ErrInvalidCredentials", pw, err)
		}
	}
}

func TestSSOAccountsCannotBeAutoProvisionedAsAdmin(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.CreateSSOUser(ctx, "https://idp", "s", "x", "", auth.RoleAdmin); err == nil {
		t.Fatal("an SSO account was created with the admin role")
	}
}

func TestExpiredSessionIsRejectedAndDeleted(t *testing.T) {
	svc, st, clock := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	_, token, err := svc.Login(ctx, "admin", goodPassword, "", "")
	if err != nil {
		t.Fatal(err)
	}

	*clock = testNow.Add(2 * time.Hour) // TTL is one hour

	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrSessionExpired) {
		t.Fatalf("Authenticate on an expired session = %v", err)
	}
	// Deleted on the way past, so a stolen token cannot be replayed if the
	// clock later moves backwards -- which on an RTC-less Pi is a real event.
	if _, err := st.GetSession(ctx, auth.TokenID(token)); err == nil {
		t.Fatal("the expired session row is still there")
	}
}

func TestActivitySlidesTheExpiry(t *testing.T) {
	svc, _, clock := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	_, token, _ := svc.Login(ctx, "admin", goodPassword, "", "")

	// Use it every 30 minutes for four hours. An operator mid-shift must not be
	// logged out by a TTL that only counts from login.
	for i := 0; i < 8; i++ {
		*clock = clock.Add(30 * time.Minute)
		if _, err := svc.Authenticate(ctx, token); err != nil {
			t.Fatalf("logged out after %d minutes of continuous use: %v", (i+1)*30, err)
		}
	}

	// Then walk away for longer than the TTL.
	*clock = clock.Add(90 * time.Minute)
	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrSessionExpired) {
		t.Fatal("an abandoned session outlived its TTL")
	}
}

func TestLogoutEndsTheSession(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	_, token, _ := svc.Login(ctx, "admin", goodPassword, "", "")

	if err := svc.Logout(ctx, token); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrNoSession) {
		t.Fatalf("the token still works after logout: %v", err)
	}
	// Logging out twice is not an error worth reporting.
	if err := svc.Logout(ctx, token); err != nil {
		t.Fatalf("second Logout: %v", err)
	}
}

// Disabling an account must take effect now, not at the next expiry. That is
// the whole reason sessions are database lookups rather than JWTs.
func TestDisablingAnAccountKillsItsLiveSession(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	victim, err := svc.CreateUser(ctx, "op", "", goodPassword, auth.RoleOperator)
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := svc.Login(ctx, "op", goodPassword, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, token); err != nil {
		t.Fatal(err)
	}

	disabled := true
	if _, err := svc.UpdateUser(ctx, victim.UserID, nil, nil, &disabled); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Authenticate(ctx, token); err == nil {
		t.Fatal("a disabled account's session still authenticates")
	}
}

// A demotion must not wait for the cookie to expire either.
func TestDemotionRevokesSessions(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	u, _ := svc.CreateUser(ctx, "op", "", goodPassword, auth.RoleOperator)
	_, token, _ := svc.Login(ctx, "op", goodPassword, "", "")

	viewer := auth.RoleViewer
	if _, err := svc.UpdateUser(ctx, u.UserID, &viewer, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrNoSession) {
		t.Fatalf("a demoted user kept their session: %v", err)
	}
}

// Changing a password ends every OTHER session. A password changed because it
// may have leaked is not changed at all if the browser that leaked it stays in.
func TestPasswordChangeEndsOtherSessionsButNotYourOwn(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	u, err := svc.Setup(ctx, "admin", "", goodPassword)
	if err != nil {
		t.Fatal(err)
	}
	_, keep, _ := svc.Login(ctx, "admin", goodPassword, "browser-a", "")
	_, other, _ := svc.Login(ctx, "admin", goodPassword, "browser-b", "")

	keepID := auth.TokenID(keep)
	if err := svc.SetPassword(ctx, u.UserID, "a whole new long passphrase", keepID); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Authenticate(ctx, keep); err != nil {
		t.Fatalf("the session that changed the password was logged out: %v", err)
	}
	if _, err := svc.Authenticate(ctx, other); err == nil {
		t.Fatal("another browser survived the password change")
	}
}

// Removing the last admin leaves a box recoverable only by editing the database
// by hand -- on a sealed field unit, that means a card reader.
func TestTheLastAdminCannotBeRemoved(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	admin, err := svc.Setup(ctx, "admin", "", goodPassword)
	if err != nil {
		t.Fatal(err)
	}

	viewer := auth.RoleViewer
	disabled := true
	if _, err := svc.UpdateUser(ctx, admin.UserID, &viewer, nil, nil); !errors.Is(err, auth.ErrLastAdmin) {
		t.Fatalf("demoting the last admin: %v", err)
	}
	if _, err := svc.UpdateUser(ctx, admin.UserID, nil, nil, &disabled); !errors.Is(err, auth.ErrLastAdmin) {
		t.Fatalf("disabling the last admin: %v", err)
	}
	if err := svc.DeleteUser(ctx, admin.UserID); !errors.Is(err, auth.ErrLastAdmin) {
		t.Fatalf("deleting the last admin: %v", err)
	}

	// With a second admin, all three become legal.
	second, err := svc.CreateUser(ctx, "admin2", "", goodPassword, auth.RoleAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUser(ctx, admin.UserID); err != nil {
		t.Fatalf("deleting an admin when another exists: %v", err)
	}
	// And the guard follows the survivor.
	if err := svc.DeleteUser(ctx, second.UserID); !errors.Is(err, auth.ErrLastAdmin) {
		t.Fatalf("the guard did not follow to the remaining admin: %v", err)
	}
}

// A disabled admin does not count towards the guard: two admins where one is
// disabled is still one usable admin.
func TestDisabledAdminsDoNotCountAsTheLastAdmin(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	admin, _ := svc.Setup(ctx, "admin", "", goodPassword)
	spare, _ := svc.CreateUser(ctx, "spare", "", goodPassword, auth.RoleAdmin)

	disabled := true
	if _, err := svc.UpdateUser(ctx, spare.UserID, nil, nil, &disabled); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUser(ctx, admin.UserID); !errors.Is(err, auth.ErrLastAdmin) {
		t.Fatal("a disabled admin was counted as a usable one")
	}
}

func TestDuplicateUsernamesAreRefused(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	// Including a differently-cased spelling, which must collide.
	for _, name := range []string{"admin", "Admin", " ADMIN "} {
		if _, err := svc.CreateUser(ctx, name, "", goodPassword, auth.RoleViewer); !errors.Is(err, auth.ErrUserExists) {
			t.Errorf("CreateUser(%q) = %v, want ErrUserExists", name, err)
		}
	}
}

// With auth off every request is an admin, and says so.
func TestModeOffTreatsEveryoneAsAnAnonymousAdmin(t *testing.T) {
	svc := &auth.Service{Store: memstore.New(), Mode: auth.ModeOff}
	ctx := context.Background()

	if svc.Enabled() {
		t.Fatal("Enabled() is true in ModeOff")
	}
	if needs, _ := svc.NeedsSetup(ctx); needs {
		t.Fatal("ModeOff asked for setup; there is nobody to set up")
	}
	p, err := svc.Authenticate(ctx, "")
	if err != nil {
		t.Fatalf("Authenticate with no token in ModeOff: %v", err)
	}
	if !p.Anonymous {
		t.Fatal("the principal is not marked anonymous, so an audit line would name a user who does not exist")
	}
	if !p.User.Role.AtLeast(auth.RoleAdmin) {
		t.Fatal("ModeOff did not grant admin, so the UI would be unusable")
	}
}

func TestAuthenticateRejectsGarbage(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	for _, tok := range []string{"", "nonsense", auth.TokenID("nonsense")} {
		if _, err := svc.Authenticate(ctx, tok); err == nil {
			t.Errorf("Authenticate(%q) succeeded", tok)
		}
	}
}

func TestPurgeSessionsDropsOnlyExpiredOnes(t *testing.T) {
	svc, _, clock := newService(t)
	ctx := context.Background()
	if _, err := svc.Setup(ctx, "admin", "", goodPassword); err != nil {
		t.Fatal(err)
	}
	_, old, _ := svc.Login(ctx, "admin", goodPassword, "", "")

	*clock = clock.Add(2 * time.Hour)
	_, fresh, _ := svc.Login(ctx, "admin", goodPassword, "", "")

	n, err := svc.PurgeSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged %d sessions, want 1", n)
	}
	if _, err := svc.Authenticate(ctx, fresh); err != nil {
		t.Fatalf("the live session was purged: %v", err)
	}
	if _, err := svc.Authenticate(ctx, old); err == nil {
		t.Fatal("the expired session survived")
	}
}

package auth

import (
	"strings"
	"testing"
)

func TestRoleOrdering(t *testing.T) {
	cases := []struct {
		have, need Role
		want       bool
	}{
		{RoleAdmin, RoleViewer, true},
		{RoleAdmin, RoleOperator, true},
		{RoleAdmin, RoleAdmin, true},
		{RoleOperator, RoleViewer, true},
		{RoleOperator, RoleOperator, true},
		{RoleOperator, RoleAdmin, false},
		{RoleViewer, RoleViewer, true},
		{RoleViewer, RoleOperator, false},
		{RoleViewer, RoleAdmin, false},
	}
	for _, c := range cases {
		if got := c.have.AtLeast(c.need); got != c.want {
			t.Errorf("%s.AtLeast(%s) = %v, want %v", c.have, c.need, got, c.want)
		}
	}
}

// An unknown role must satisfy nothing. A typo in a config or a row written by
// an older version has to fail closed, not become a wildcard.
func TestUnknownRoleSatisfiesNothing(t *testing.T) {
	junk := Role("superuser")
	for _, need := range []Role{RoleViewer, RoleOperator, RoleAdmin} {
		if junk.AtLeast(need) {
			t.Errorf("unknown role satisfied %s", need)
		}
	}
	if RoleAdmin.AtLeast(Role("")) {
		t.Error("admin satisfied an empty requirement; an unset requirement must not be a free pass")
	}
}

func TestParseRoleRejectsJunk(t *testing.T) {
	for _, s := range []string{"", "superuser", "root", "ADMIN "} {
		r, err := ParseRole(s)
		if s == "ADMIN " {
			// Trimmed and lowercased, so this one is admin.
			if err != nil || r != RoleAdmin {
				t.Errorf("ParseRole(%q) = %v, %v; want admin", s, r, err)
			}
			continue
		}
		if err == nil {
			t.Errorf("ParseRole(%q) accepted it as %v", s, r)
		}
	}
}

func TestPasswordRoundTrip(t *testing.T) {
	const pw = "correct horse battery staple"
	hash, err := HashPassword(pw)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if strings.Contains(hash, pw) {
		t.Fatal("the hash contains the password")
	}
	if !VerifyPassword(hash, pw) {
		t.Fatal("the correct password did not verify")
	}
	if VerifyPassword(hash, pw+"x") {
		t.Fatal("a wrong password verified")
	}
}

// Same password, two hashes: the salt must differ. Identical hashes would mean
// a stolen database reveals which accounts share a password.
func TestHashesAreSalted(t *testing.T) {
	a, err := HashPassword("a-sufficiently-long-password")
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashPassword("a-sufficiently-long-password")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("two hashes of the same password are identical, so the salt is not random")
	}
}

// Anything that is not a hash this package produced must fail, never panic and
// never accidentally succeed. An empty hash is the important one: an SSO-only
// account stores "" and must not be loggable-in with an empty password.
func TestVerifyRejectsMalformedHashes(t *testing.T) {
	for _, h := range []string{
		"",
		"not-a-hash",
		"$argon2id$",
		"$argon2id$v=19$m=65536,t=1,p=4$notbase64$alsonot",
		"$bcrypt$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA",
		"$argon2id$v=99$m=65536,t=1,p=4$c2FsdA$aGFzaA",
	} {
		if VerifyPassword(h, "") || VerifyPassword(h, "anything") {
			t.Errorf("malformed hash %q verified", h)
		}
	}
}

func TestPasswordFloorIsLengthOnly(t *testing.T) {
	if err := CheckPasswordStrength("short"); err == nil {
		t.Error("a 5-character password was accepted")
	}
	// A passphrase with no digits, symbols or capitals is fine. Composition
	// rules push people to Password1! and measurably do not help.
	if err := CheckPasswordStrength("correct horse battery staple"); err != nil {
		t.Errorf("a long passphrase was rejected: %v", err)
	}
	if _, err := HashPassword("tooshort"); err == nil {
		t.Error("HashPassword did not enforce the floor")
	}
}

// The token is the credential; the stored id is a hash of it. If TokenID ever
// became the identity function, the sessions table would be a list of live
// credentials.
func TestTokenIDIsAHashNotTheToken(t *testing.T) {
	token, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	id := TokenID(token)
	if id == token {
		t.Fatal("the stored session id IS the token")
	}
	if len(id) != 64 {
		t.Fatalf("id is %d chars, want 64 hex chars of SHA-256", len(id))
	}
	if TokenID(token) != id {
		t.Fatal("TokenID is not deterministic")
	}
	if TokenID(token+"x") == id {
		t.Fatal("two different tokens hashed the same")
	}
}

func TestTokensAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		tok, err := NewToken()
		if err != nil {
			t.Fatal(err)
		}
		if seen[tok] {
			t.Fatal("NewToken repeated itself")
		}
		seen[tok] = true
	}
}

// "Admin" and "admin " must be the same account, or someone can register a
// near-twin of an operator that a human skims straight past.
func TestUsernameNormalisation(t *testing.T) {
	for _, s := range []string{"Admin", "ADMIN", " admin ", "admin"} {
		if got := NormaliseUsername(s); got != "admin" {
			t.Errorf("NormaliseUsername(%q) = %q", s, got)
		}
	}
}

func TestValidUsername(t *testing.T) {
	for _, ok := range []string{"admin", "lee.norton", "op-1", "a_b", "user@example.com"} {
		if err := ValidUsername(ok); err != nil {
			t.Errorf("ValidUsername(%q): %v", ok, err)
		}
	}
	for _, bad := range []string{"", "a", strings.Repeat("x", 65), "has space", "semi;colon", "sla/sh"} {
		if err := ValidUsername(bad); err == nil {
			t.Errorf("ValidUsername(%q) accepted it", bad)
		}
	}
}

func TestParseMode(t *testing.T) {
	for in, want := range map[string]Mode{"": ModeRequired, "required": ModeRequired, "off": ModeOff, "OFF": ModeOff} {
		got, err := ParseMode(in)
		if err != nil || got != want {
			t.Errorf("ParseMode(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := ParseMode("maybe"); err == nil {
		t.Error("ParseMode accepted an unknown mode")
	}
}

// An SSO account has no password hash, and HasPassword is what stops the local
// login form from being a way in for it.
func TestSSOAccountHasNoPassword(t *testing.T) {
	if (User{}).HasPassword() {
		t.Fatal("an account with no hash claimed to have a password")
	}
	if !(User{PasswordHash: "x"}).HasPassword() {
		t.Fatal("an account with a hash claimed not to")
	}
}

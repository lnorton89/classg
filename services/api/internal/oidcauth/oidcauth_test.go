package oidcauth

import "testing"

// safeReturn is the whole defence against an open redirect on the login
// endpoint, and it had no test at all. Its own comment states the stake: "an
// open redirect on a login endpoint is exactly what a phishing page wants: a
// real login screen on the real domain that lands the victim somewhere else."
//
// The value reaches it straight from `?return=` on /auth/sso/start, is stored
// against the flow, and comes back out of Exchange into
// http.Redirect(w, r, id.Return, ...) -- so whatever survives here is a
// Location header.
func TestSafeReturnKeepsTheRedirectInsideTheApp(t *testing.T) {
	stays := []string{
		"/",
		"/tracks",
		"/tracks/01J8XQ",
		"/settings?tab=general",
		"/live#map",
	}
	for _, in := range stays {
		if got := safeReturn(in); got != in {
			t.Errorf("safeReturn(%q) = %q, want it unchanged", in, got)
		}
	}

	escapes := []string{
		"",                     // nothing to return to
		"//evil.example",       // protocol-relative
		"///evil.example",      // three slashes, same trick
		"https://evil.example", // absolute
		"http://evil.example",  // absolute
		"evil.example",         // no leading slash: relative to the current dir
		"\\\\evil.example",     // backslashes only
		"/\\evil.example",      // slash-backslash: browsers read this as //
		"/\\/evil.example",     // and this
		"javascript:alert(1)",  // scheme, not a path
		" //evil.example",      // leading space, trimmed by some parsers
		"\t//evil.example",     // and a tab
		"/\t/evil.example",     // embedded tab
		"/\n/evil.example",     // embedded newline
	}
	for _, in := range escapes {
		if got := safeReturn(in); got != "/" {
			t.Errorf("safeReturn(%q) = %q, want %q -- this is a Location header", in, got, "/")
		}
	}
}

// Which claim becomes the local username decides what an attacker at the
// provider has to control to name themselves after somebody. The second return
// says whether that name came from an email, which is a claim the provider may
// never have checked -- and that is what stops it linking to an account that
// already exists.
func TestPickUsernameReportsWhenTheNameCameFromAnEmail(t *testing.T) {
	tests := []struct {
		claim     string
		preferred string
		email     string
		sub       string
		want      string
		fromEmail bool
	}{
		{"email", "alice", "Alice@Example.com", "sub-1", "alice@example.com", true},
		{"sub", "alice", "alice@example.com", "sub-1", "sub-1", false},
		{"preferred_username", "Alice", "alice@example.com", "sub-1", "alice", false},
		// The default: preferred_username where the provider sends one...
		{"", "Alice", "alice@example.com", "sub-1", "alice", false},
		// ...and the email where it does not, which is the case a reader of
		// CLASSG_OIDC_USERNAME_CLAIM would not think of.
		{"", "", "Alice@Example.com", "sub-1", "alice@example.com", true},
	}
	for _, tc := range tests {
		p := &Provider{cfg: Config{UsernameClaim: tc.claim}}
		got, fromEmail := p.pickUsername(tc.preferred, tc.email, tc.sub)
		if got != tc.want || fromEmail != tc.fromEmail {
			t.Errorf("claim %q: got (%q, %v), want (%q, %v)",
				tc.claim, got, fromEmail, tc.want, tc.fromEmail)
		}
	}
}

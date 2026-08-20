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

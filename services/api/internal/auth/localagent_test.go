package auth

import (
	"os"
	"path/filepath"
	"testing"
)

// The token file IS the authorization. Its permissions are what makes "a
// process on this box" mean "the account that owns this deployment", so a
// permissive umask publishing it to every user is the whole defence gone.
func TestLocalTokenFileIsNotWorldReadable(t *testing.T) {
	old := syscallUmask(0)
	defer syscallUmask(old)

	dir := t.TempDir()
	a, err := NewLocalAgent(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !a.Enabled() {
		t.Fatal("no token was minted")
	}

	fi, err := os.Stat(filepath.Join(dir, LocalTokenFile))
	if err != nil {
		t.Fatal(err)
	}
	if mode := fi.Mode().Perm(); mode&0o007 != 0 {
		t.Errorf("token file is %o; anything readable by other defeats the point of a file-based grant", mode)
	}
	if mode := fi.Mode().Perm(); mode&0o002 != 0 {
		t.Errorf("token file is %o and group-writable; the group could replace the unit's credential", mode)
	}
}

func TestLocalTokenMatchesOnlyItself(t *testing.T) {
	a, err := NewLocalAgent(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(a.Path())
	if err != nil {
		t.Fatal(err)
	}
	// The file ends with a newline so `cat` and shell capture behave; the
	// token itself does not include it.
	written := string(body)
	trimmed := written[:len(written)-1]

	if !a.Matches(trimmed) {
		t.Error("the token as written to the file did not authenticate")
	}
	for _, wrong := range []string{"", " ", written, trimmed + "x", trimmed[:len(trimmed)-1], "Bearer " + trimmed} {
		if a.Matches(wrong) {
			t.Errorf("%q authenticated as the local agent", wrong)
		}
	}
}

// Two units, or one unit restarted, must not share a credential.
func TestLocalTokensAreNotReused(t *testing.T) {
	a, err := NewLocalAgent(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewLocalAgent(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if a.Matches(b.token) || b.Matches(a.token) {
		t.Fatal("two agents minted the same token")
	}
}

// No agent-state directory is the ordinary case for a development run, and an
// agent that authenticates nobody must not authenticate everybody.
func TestNoDirectoryMeansNobodyAuthenticates(t *testing.T) {
	for _, dir := range []string{"", "   "} {
		a, err := NewLocalAgent(dir)
		if err != nil {
			t.Fatalf("%q: %v", dir, err)
		}
		if a.Enabled() {
			t.Errorf("%q minted a token", dir)
		}
		for _, presented := range []string{"", "anything", "\x00"} {
			if a.Matches(presented) {
				t.Errorf("%q authenticated against an agent with no token", presented)
			}
		}
	}

	// And a nil agent, which is what a Server built without one holds before
	// New fills it in.
	var nilAgent *LocalAgent
	if nilAgent.Enabled() || nilAgent.Matches("") || nilAgent.Matches("x") {
		t.Error("a nil agent authenticated something")
	}
}

// Viewer, and only viewer. Everything above it is a person's decision, and
// this principal is a file on disk.
func TestLocalAgentIsAViewer(t *testing.T) {
	a, err := NewLocalAgent(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := a.Principal()
	if p.User.Role != RoleViewer {
		t.Fatalf("role is %s, want viewer", p.User.Role)
	}
	if p.User.Role.AtLeast(RoleOperator) || p.User.Role.AtLeast(RoleAdmin) {
		t.Error("the local agent satisfies a role above viewer")
	}
	if p.Anonymous {
		t.Error("the local agent is a named principal, not the ModeOff anonymous one")
	}
	if p.User.Username != LocalAgentUsername {
		t.Errorf("username is %q", p.User.Username)
	}
}

// An unwritable directory must degrade, not stop the unit starting.
func TestAnUnwritableDirectoryDegrades(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does", "not", "exist")
	a, err := NewLocalAgent(dir)
	if err == nil {
		t.Fatal("expected an error naming the directory")
	}
	if a == nil || a.Enabled() {
		t.Fatal("a failed mint must still return an agent that authenticates nobody")
	}
}

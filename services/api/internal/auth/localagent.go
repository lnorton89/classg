package auth

import (
	"crypto/subtle"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LocalAgentUsername is the principal a local-token request runs as. It is not
// a row in the users table and never appears in Administration -- there is no
// account here to disable, only a file to delete.
const LocalAgentUsername = "local-agent"

// LocalTokenFile is the name written inside the agent-state directory.
const LocalTokenFile = "local-api-token"

// LocalAgent authenticates a process running on this unit's own host.
//
// The problem it solves: pi-dash sits on the Pi, next to the API, and had no
// way to authenticate except a session cookie copied out of a browser by hand.
// That is a live credential for the whole unit, pasted into a shell, expiring
// on a sliding 12 hours -- for a dashboard whose entire job is being glanceable
// without ceremony. A process already on the machine, running as the account
// that owns the deployment, should not have to borrow a human's session.
//
// Why a token file rather than trusting loopback: "any request from 127.0.0.1
// is a viewer" would also trust anything that can make this API issue a request
// to itself, and the API is reached through nginx and a tailnet as well, where
// the peer address is not evidence of anything. A file carries the trust in its
// permissions -- the answer to "is this process the operator?" becomes "can it
// read a 0640 file in the operator's own state directory?", which is a question
// the kernel answers.
//
// Why not a real session for a real account: NeedsSetup is CountUsers() == 0,
// so an auto-created account on a fresh unit would mean the first-run setup
// screen never appears and the unit could never get an administrator. A
// credential that is deliberately not a session stays out of that machinery
// entirely.
//
// Viewer, always. Everything above viewer needs a person.
type LocalAgent struct {
	token string
	path  string
}

// NewLocalAgent mints a token and writes it into dir.
//
// A missing or unwritable directory is not an error: it means this deployment
// has no host-side agents (dir is empty when CLASSG_DEPLOY_STATE_DIR is unset),
// and the returned agent simply authenticates nobody. Failing to start over a
// dashboard's convenience would be the wrong trade.
func NewLocalAgent(dir string) (*LocalAgent, error) {
	if strings.TrimSpace(dir) == "" {
		return &LocalAgent{}, nil
	}
	token, err := NewToken()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, LocalTokenFile)

	// Written and renamed, so a reader never sees a half-written token, and
	// 0640 so the token is readable by the operator account that shares this
	// directory's group and by nobody else -- the directory itself is 2775 and
	// world-readable, which governs listing, not this file's contents.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0o640); err != nil {
		_ = os.Remove(tmp)
		return &LocalAgent{}, fmt.Errorf("writing %s: %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return &LocalAgent{}, fmt.Errorf("renaming %s: %w", path, err)
	}
	// WriteFile's mode is masked by umask; set it explicitly so a permissive
	// umask cannot publish the token to every account on the box.
	if err := os.Chmod(path, 0o640); err != nil {
		return &LocalAgent{}, fmt.Errorf("securing %s: %w", path, err)
	}
	return &LocalAgent{token: token, path: path}, nil
}

// Enabled reports whether a token was minted.
func (l *LocalAgent) Enabled() bool { return l != nil && l.token != "" }

// Path is where the token was written, for logging.
func (l *LocalAgent) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

// Matches reports whether presented is this unit's local token.
//
// The Enabled check is what stops a deployment with no agent-state directory
// authenticating anything: with no token minted, l.token is "" and a caller
// sending "" would otherwise compare equal. The empty-presented check after it
// is belt and braces -- ConstantTimeCompare already returns 0 on a length
// mismatch, so it changes no outcome, and removing it fails no test.
func (l *LocalAgent) Matches(presented string) bool {
	if !l.Enabled() || presented == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(l.token)) == 1
}

// Principal is who a local-token request runs as.
func (l *LocalAgent) Principal() Principal {
	return Principal{
		User: User{
			Username:    LocalAgentUsername,
			DisplayName: "Local agent on this unit",
			Role:        RoleViewer,
		},
	}
}

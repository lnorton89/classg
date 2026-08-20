package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/httpapi"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/monitoring"
	"github.com/classg/api/internal/settings"
	"github.com/classg/api/internal/store/memstore"
)

// The local agent is a second way into an authenticated API, which is a thing
// worth being unpleasant about. These drive the middleware rather than the
// LocalAgent type: what matters is not that Matches works, but that a request
// carrying the token gets viewer and stops there, and that everything else
// still gets nothing.

type localHarness struct {
	server *httpapi.Server
	svc    *auth.Service
	token  string
	dir    string
}

func newLocalHarness(t *testing.T) *localHarness {
	t.Helper()
	env := map[string]string{
		"CLASSG_STORE":              "memory",
		"CLASSG_TRACK_ENDPOINT":     "off",
		"CLASSG_DETECTION_ENDPOINT": "off",
		"CLASSG_UI_DIR":             t.TempDir(),
	}
	getenv := func(k string) string { return env[k] }
	boot, err := config.LoadBootstrap(getenv)
	if err != nil {
		t.Fatal(err)
	}
	set, err := settings.Resolve(nil, nil, getenv)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Assemble(boot, set)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	agent, err := auth.NewLocalAgent(dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, auth.LocalTokenFile))
	if err != nil {
		t.Fatal(err)
	}

	st := memstore.New()
	svc := &auth.Service{Store: st, Mode: auth.ModeRequired, TTL: time.Hour}
	return &localHarness{
		server: httpapi.New(httpapi.Options{
			Config: cfg, Settings: set, Store: st,
			Registry:   health.NewRegistry(cfg.SensorStaleAfter),
			Hub:        hub.New(),
			Captures:   capture.NewManager(st, capture.Options{Dir: t.TempDir()}),
			Monitoring: monitoring.New(false, time.Now().UTC()),
			Auth:       svc,
			LocalAgent: agent,
			Sensors:    fakeSensors{},
			Started:    time.Now(),
		}),
		svc:   svc,
		token: strings.TrimSpace(string(raw)),
		dir:   dir,
	}
}

func (h *localHarness) get(t *testing.T, path, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if authorization != "" {
		r.Header.Set("Authorization", authorization)
	}
	w := httptest.NewRecorder()
	h.server.ServeHTTP(w, r)
	return w
}

// The point of the feature: a process holding the file reads without a person
// having pasted a cookie into a shell.
func TestLocalTokenReadsWithoutASession(t *testing.T) {
	h := newLocalHarness(t)
	h.seed(t)

	if w := h.get(t, "/api/v1/tracks", "Bearer "+h.token); w.Code != http.StatusOK {
		t.Fatalf("tracks with the local token: %d (%s)", w.Code, w.Body.String())
	}
	if w := h.get(t, "/api/v1/sensors", "Bearer "+h.token); w.Code != http.StatusOK {
		t.Fatalf("sensors with the local token: %d (%s)", w.Code, w.Body.String())
	}
}

// Viewer and no further. A read credential on disk must not be a way to stop
// recording or restart a radio.
func TestLocalTokenIsRefusedAboveViewer(t *testing.T) {
	h := newLocalHarness(t)
	h.seed(t)

	for _, path := range []string{"/api/v1/admin/users", "/api/v1/admin/sessions"} {
		w := h.get(t, path, "Bearer "+h.token)
		if w.Code != http.StatusForbidden {
			t.Errorf("GET %s with the local token: %d, want 403 (%s)", path, w.Code, w.Body.String())
		}
	}

	r := httptest.NewRequest(http.MethodPost, "/api/v1/sensors/wifi-0/restart", nil)
	r.Header.Set("Authorization", "Bearer "+h.token)
	w := httptest.NewRecorder()
	h.server.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("restart with the local token: %d, want 403 (%s)", w.Code, w.Body.String())
	}
}

// Everything that is not the token, including the shapes a near-miss takes.
func TestOnlyTheTokenAuthenticates(t *testing.T) {
	h := newLocalHarness(t)
	h.seed(t)

	wrong := []string{
		"",
		"Bearer ",
		"Bearer wrong",
		"Bearer " + h.token + "x",
		"Bearer " + h.token[:len(h.token)-1],
		h.token,            // no scheme
		"Basic " + h.token, // wrong scheme
	}
	for _, header := range wrong {
		w := h.get(t, "/api/v1/tracks", header)
		if w.Code == http.StatusOK {
			t.Errorf("Authorization %q was accepted", header)
		}
	}
}

// Whitespace around the credential is tolerated, and that is deliberate rather
// than sloppy. RFC 7235's grammar is `auth-scheme 1*SP credentials`, so more
// than one space is legal; and the token file ends with a newline so that `cat`
// and shell capture behave, which means a client that reads the file whole and
// sends it verbatim would otherwise be mysteriously unauthorised. It is the
// same secret either way -- nothing is widened but the framing.
func TestSurroundingWhitespaceIsTolerated(t *testing.T) {
	h := newLocalHarness(t)
	h.seed(t)

	for _, header := range []string{
		"Bearer  " + h.token,
		"Bearer " + h.token + " ",
		"Bearer " + h.token + "\n", // the file's own content, sent whole
	} {
		if w := h.get(t, "/api/v1/tracks", header); w.Code != http.StatusOK {
			t.Errorf("Authorization %q: %d, want 200", header, w.Code)
		}
	}
}

// The scheme is case-insensitive per RFC 7235, and a client that sends "bearer"
// should not be mysteriously unauthorised.
func TestSchemeIsCaseInsensitive(t *testing.T) {
	h := newLocalHarness(t)
	h.seed(t)

	for _, scheme := range []string{"Bearer", "bearer", "BEARER"} {
		if w := h.get(t, "/api/v1/tracks", scheme+" "+h.token); w.Code != http.StatusOK {
			t.Errorf("%s: %d", scheme, w.Code)
		}
	}
}

// A unit built without an agent-state directory has no local token, and must
// not therefore treat an empty or arbitrary Authorization header as one.
func TestAnAPIWithNoLocalAgentAcceptsNothing(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	if _, err := h.svc.Setup(context.Background(), "root", "Root", testPassword); err != nil {
		t.Fatal(err)
	}

	for _, header := range []string{"", "Bearer ", "Bearer anything"} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/tracks", nil)
		if header != "" {
			r.Header.Set("Authorization", header)
		}
		w := httptest.NewRecorder()
		h.server.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("Authorization %q: %d, want 401 (%s)", header, w.Code, w.Body.String())
		}
	}
}

// On a unit with no accounts every other protected route answers
// setup_required. The local agent is checked before that, deliberately: a
// dashboard on the host is most useful on a unit nobody has finished setting
// up, and it still cannot create the administrator -- setup is its own
// unauthenticated route and does not pass through this middleware.
func TestLocalTokenReadsBeforeSetupIsDone(t *testing.T) {
	h := newLocalHarness(t)

	if w := h.get(t, "/api/v1/tracks", "Bearer "+h.token); w.Code != http.StatusOK {
		t.Fatalf("local token on an unset-up unit: %d (%s)", w.Code, w.Body.String())
	}
	// And a request without it still says setup is required rather than 401.
	w := h.get(t, "/api/v1/tracks", "")
	if w.Code == http.StatusOK {
		t.Fatal("an anonymous request read a unit with no accounts")
	}
}

// /auth/me is public and answers the question the dashboard puts on screen.
// Without this the local agent would be authenticated on every other endpoint
// while this one reported nobody logged in -- a pane contradicting itself,
// which is worse than one that says nothing.
func TestAuthMeRecognisesTheLocalAgent(t *testing.T) {
	h := newLocalHarness(t)
	h.seed(t)

	w := h.get(t, "/api/v1/auth/me", "Bearer "+h.token)
	if w.Code != http.StatusOK {
		t.Fatalf("auth/me: %d", w.Code)
	}
	var me struct {
		Authenticated bool `json:"authenticated"`
		User          *struct {
			Username string `json:"username"`
			Role     string `json:"role"`
		} `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if !me.Authenticated || me.User == nil {
		t.Fatalf("auth/me did not report the local agent: %s", w.Body.String())
	}
	if me.User.Username != auth.LocalAgentUsername || me.User.Role != "viewer" {
		t.Errorf("auth/me reported %+v", me.User)
	}

	// And a wrong token is still nobody, rather than an error.
	w = h.get(t, "/api/v1/auth/me", "Bearer wrong")
	if w.Code != http.StatusOK {
		t.Fatalf("auth/me with a wrong token: %d", w.Code)
	}
	me.Authenticated = true
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if me.Authenticated {
		t.Error("a wrong bearer token was reported as authenticated")
	}
}

func (h *localHarness) seed(t *testing.T) {
	t.Helper()
	if _, err := h.svc.Setup(context.Background(), "root", "Root", testPassword); err != nil {
		t.Fatalf("Setup: %v", err)
	}
}

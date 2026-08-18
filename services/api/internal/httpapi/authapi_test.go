package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

const testPassword = "correct horse battery staple"

type authHarness struct {
	server *httpapi.Server
	svc    *auth.Service
	store  *memstore.Store
}

func newAuthHarness(t *testing.T, mode auth.Mode) *authHarness {
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
		t.Fatalf("bootstrap: %v", err)
	}
	set, err := settings.Resolve(nil, nil, getenv)
	if err != nil {
		t.Fatalf("settings: %v", err)
	}
	cfg, err := config.Assemble(boot, set)
	if err != nil {
		t.Fatalf("config: %v", err)
	}

	st := memstore.New()
	svc := &auth.Service{Store: st, Mode: mode, TTL: time.Hour}

	return &authHarness{
		server: httpapi.New(httpapi.Options{
			Config: cfg, Settings: set, Store: st,
			Registry:   health.NewRegistry(cfg.SensorStaleAfter),
			Hub:        hub.New(),
			Captures:   capture.NewManager(st, capture.Options{Dir: t.TempDir()}),
			Monitoring: monitoring.New(false, time.Now().UTC()),
			Auth:       svc,
			Sensors:    fakeSensors{},
			Started:    time.Now(),
		}),
		svc: svc, store: st,
	}
}

// do issues a request, optionally carrying a session cookie.
func (h *authHarness) do(t *testing.T, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.AddCookie(&http.Cookie{Name: httpapi.SessionCookie, Value: token})
	}
	w := httptest.NewRecorder()
	h.server.ServeHTTP(w, r)
	return w
}

// login returns a session token for a freshly created account of the given role.
func (h *authHarness) login(t *testing.T, username string, role auth.Role) string {
	t.Helper()
	ctx := context.Background()
	if _, err := h.svc.CreateUser(ctx, username, "", testPassword, role); err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	_, token, err := h.svc.Login(ctx, username, testPassword, "test", "")
	if err != nil {
		t.Fatalf("Login(%s): %v", username, err)
	}
	return token
}

// seedAdmin gets the harness past the setup gate.
func (h *authHarness) seedAdmin(t *testing.T) string {
	t.Helper()
	if _, err := h.svc.Setup(context.Background(), "root", "Root", testPassword); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	_, token, err := h.svc.Login(context.Background(), "root", testPassword, "test", "")
	if err != nil {
		t.Fatal(err)
	}
	return token
}

// The table this whole feature stands on. Every protected endpoint, the minimum
// role it should need, and a check that each role above and below lands where
// it should. A route that silently loses its guard shows up here.
func TestRoleEnforcementAcrossTheAPI(t *testing.T) {
	cases := []struct {
		method, path, body string
		need               auth.Role
	}{
		{"GET", "/api/v1/tracks", "", auth.RoleViewer},
		{"GET", "/api/v1/detections", "", auth.RoleViewer},
		{"GET", "/api/v1/system", "", auth.RoleViewer},
		{"GET", "/api/v1/telemetry", "", auth.RoleViewer},
		{"GET", "/api/v1/sensors", "", auth.RoleViewer},
		{"GET", "/api/v1/captures", "", auth.RoleViewer},
		{"GET", "/api/v1/spectrum/bands", "", auth.RoleViewer},
		{"GET", "/api/v1/config/settings", "", auth.RoleViewer},
		// GraphQL reads the same rows as the endpoints above, so it sits at
		// the same level. It carries no admin surface at all -- see
		// internal/graphqlapi -- which is what keeps one role correct for the
		// whole endpoint.
		{"POST", "/api/v1/graphql", `{"query":"{ health { status } }"}`, auth.RoleViewer},

		{"POST", "/api/v1/captures", `{"iface":"wlan1"}`, auth.RoleOperator},
		{"POST", "/api/v1/spectrum/sweeps", `{"band":"ism_915"}`, auth.RoleOperator},
		{"POST", "/api/v1/sensors/wifi-0/restart", "", auth.RoleOperator},
		{"PUT", "/api/v1/monitoring", `{"enabled":true}`, auth.RoleOperator},

		// Admin: this can repoint the store, the bus and the capture directory.
		{"PUT", "/api/v1/config/settings", `{"values":{}}`, auth.RoleAdmin},
		{"GET", "/api/v1/admin/users", "", auth.RoleAdmin},
		{"POST", "/api/v1/admin/users", `{"username":"x","password":"` + testPassword + `","role":"viewer"}`, auth.RoleAdmin},
		{"GET", "/api/v1/admin/sessions", "", auth.RoleAdmin},
		{"DELETE", "/api/v1/admin/users/nope", "", auth.RoleAdmin},
	}

	roles := []auth.Role{auth.RoleViewer, auth.RoleOperator, auth.RoleAdmin}

	for _, c := range cases {
		for _, have := range roles {
			t.Run(c.method+" "+c.path+" as "+have.String(), func(t *testing.T) {
				h := newAuthHarness(t, auth.ModeRequired)
				h.seedAdmin(t)
				token := h.login(t, "user-"+have.String(), have)

				w := h.do(t, c.method, c.path, c.body, token)

				if have.AtLeast(c.need) {
					if w.Code == http.StatusForbidden {
						t.Fatalf("%s was refused with 403 but should satisfy %s", have, c.need)
					}
					return
				}
				if w.Code != http.StatusForbidden {
					t.Fatalf("%s reached a %s endpoint: got %d, want 403", have, c.need, w.Code)
				}
				// 403, never 401: a viewer clicking an admin link must stay
				// logged in rather than being bounced to a login screen.
				if code := decodeErr(t, w).Error.Code; code != "forbidden" {
					t.Fatalf("error code %q, want forbidden", code)
				}
			})
		}
	}
}

// No cookie at all is 401 on everything protected.
func TestUnauthenticatedRequestsAreRefused(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	h.seedAdmin(t)

	for _, path := range []string{
		"/api/v1/tracks", "/api/v1/detections", "/api/v1/system",
		"/api/v1/sensors", "/api/v1/admin/users", "/api/v1/spectrum/bands",
	} {
		w := h.do(t, "GET", path, "", "")
		if w.Code != http.StatusUnauthorized {
			t.Errorf("GET %s with no session = %d, want 401", path, w.Code)
		}
		if code := decodeErr(t, w).Error.Code; code != "unauthenticated" {
			t.Errorf("GET %s error code %q", path, code)
		}
	}
}

// A garbage or revoked cookie is not a way in.
func TestForgedAndRevokedTokensAreRefused(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	h.seedAdmin(t)
	token := h.login(t, "op", auth.RoleOperator)

	if w := h.do(t, "GET", "/api/v1/tracks", "", token); w.Code != http.StatusOK {
		t.Fatalf("a valid session was refused: %d", w.Code)
	}
	for _, forged := range []string{"nonsense", token + "x", auth.TokenID(token)} {
		if w := h.do(t, "GET", "/api/v1/tracks", "", forged); w.Code != http.StatusUnauthorized {
			t.Errorf("forged token %q got %d, want 401", forged, w.Code)
		}
	}

	// The stored id must not work as a token. If it did, a database dump would
	// be a list of live credentials.
	if err := h.svc.Logout(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if w := h.do(t, "GET", "/api/v1/tracks", "", token); w.Code != http.StatusUnauthorized {
		t.Fatalf("a logged-out token still works: %d", w.Code)
	}
}

// A unit with no accounts serves nothing but setup. Answering 401 would send a
// browser to a login screen that cannot succeed.
func TestAFreshUnitDemandsSetupBeforeAnythingElse(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)

	w := h.do(t, "GET", "/api/v1/tracks", "", "")
	if w.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409 setup_required", w.Code)
	}
	if code := decodeErr(t, w).Error.Code; code != "setup_required" {
		t.Fatalf("error code %q", code)
	}

	// /auth/me must answer, because it is how the client knows to draw the
	// setup screen at all.
	w = h.do(t, "GET", "/api/v1/auth/me", "", "")
	if w.Code != http.StatusOK {
		t.Fatalf("/auth/me on a fresh unit = %d", w.Code)
	}
	var me struct {
		SetupRequired bool `json:"setup_required"`
		AuthEnabled   bool `json:"auth_enabled"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if !me.SetupRequired || !me.AuthEnabled {
		t.Fatalf("got %+v", me)
	}
}

// Setup creates an admin, logs them in, and closes itself.
func TestSetupFlow(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)

	body := `{"username":"admin","display_name":"Admin","password":"` + testPassword + `"}`
	w := h.do(t, "POST", "/api/v1/auth/setup", body, "")
	if w.Code != http.StatusCreated {
		t.Fatalf("setup = %d: %s", w.Code, w.Body)
	}

	// The response sets a session cookie, so the new admin is not made to
	// retype the password they just chose.
	var token string
	for _, c := range w.Result().Cookies() {
		if c.Name == httpapi.SessionCookie {
			token = c.Value
		}
	}
	if token == "" {
		t.Fatal("setup did not set a session cookie")
	}
	if w := h.do(t, "GET", "/api/v1/admin/users", "", token); w.Code != http.StatusOK {
		t.Fatalf("the new admin cannot reach the admin API: %d", w.Code)
	}

	// The gate closes. This endpoint is unauthenticated, so a second call
	// succeeding would be an open account-creation form.
	w = h.do(t, "POST", "/api/v1/auth/setup",
		`{"username":"attacker","password":"`+testPassword+`"}`, "")
	if w.Code != http.StatusConflict {
		t.Fatalf("second setup = %d, want 409", w.Code)
	}
}

func TestSetupRefusesAWeakPassword(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	w := h.do(t, "POST", "/api/v1/auth/setup", `{"username":"admin","password":"short"}`, "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", w.Code)
	}
	if f := decodeErr(t, w).Error.Field; f != "password" {
		t.Fatalf("field %q, want password", f)
	}
}

func TestLoginSetsAnHttpOnlyCookieAndLogoutClearsIt(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	h.seedAdmin(t)

	w := h.do(t, "POST", "/api/v1/auth/login",
		`{"username":"root","password":"`+testPassword+`"}`, "")
	if w.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", w.Code, w.Body)
	}

	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == httpapi.SessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no session cookie")
	}
	// HttpOnly is what stops an XSS in the web app walking off with a live
	// session.
	if !cookie.HttpOnly {
		t.Error("the session cookie is not HttpOnly")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite is %v, want Lax (Strict breaks the SSO redirect back)", cookie.SameSite)
	}
	// The response body must never carry the hash.
	if strings.Contains(w.Body.String(), "argon2") || strings.Contains(w.Body.String(), "password_hash") {
		t.Fatalf("the login response leaked a password hash: %s", w.Body)
	}

	w = h.do(t, "POST", "/api/v1/auth/logout", "", cookie.Value)
	if w.Code != http.StatusNoContent {
		t.Fatalf("logout = %d", w.Code)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == httpapi.SessionCookie && c.MaxAge >= 0 {
			t.Error("logout did not expire the cookie")
		}
	}
}

func TestLoginWithBadCredentialsIs401WithOneMessage(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	h.seedAdmin(t)

	wrongUser := h.do(t, "POST", "/api/v1/auth/login", `{"username":"nobody","password":"`+testPassword+`"}`, "")
	wrongPass := h.do(t, "POST", "/api/v1/auth/login", `{"username":"root","password":"definitely not it"}`, "")

	for _, w := range []*httptest.ResponseRecorder{wrongUser, wrongPass} {
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("got %d, want 401", w.Code)
		}
	}
	// Identical bodies, or the form is a username oracle.
	if wrongUser.Body.String() != wrongPass.Body.String() {
		t.Fatalf("the two failures differ:\n  unknown user: %s\n  wrong pass:   %s",
			wrongUser.Body, wrongPass.Body)
	}
}

// Health and metrics stay open: a probe has no cookie, and a unit that only
// reports its health to authenticated callers cannot be monitored by the thing
// that notices it died.
func TestHealthAndMetricsStayPublic(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	h.seedAdmin(t)

	if w := h.do(t, "GET", "/api/v1/health", "", ""); w.Code != http.StatusOK {
		t.Errorf("/health with no session = %d", w.Code)
	}
	if w := h.do(t, "GET", "/metrics", "", ""); w.Code != http.StatusOK {
		t.Errorf("/metrics with no session = %d", w.Code)
	}
}

// With auth off, everything works with no cookie and /auth/me says so, so the
// UI can draw its banner rather than pretending someone is logged in.
func TestModeOffLetsEverythingThrough(t *testing.T) {
	h := newAuthHarness(t, auth.ModeOff)

	for _, path := range []string{"/api/v1/tracks", "/api/v1/admin/users", "/api/v1/system"} {
		if w := h.do(t, "GET", path, "", ""); w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden {
			t.Errorf("GET %s in ModeOff = %d", path, w.Code)
		}
	}

	w := h.do(t, "GET", "/api/v1/auth/me", "", "")
	var me struct {
		AuthEnabled   bool `json:"auth_enabled"`
		Authenticated bool `json:"authenticated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if me.AuthEnabled {
		t.Error("auth_enabled is true in ModeOff")
	}
	if me.Authenticated {
		t.Error("authenticated is true in ModeOff; nobody is logged in")
	}
}

// An admin listing users must never receive password hashes.
func TestAdminUserListCarriesNoHashes(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	token := h.seedAdmin(t)
	h.login(t, "op", auth.RoleOperator)

	w := h.do(t, "GET", "/api/v1/admin/users", "", token)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d", w.Code)
	}
	body := w.Body.String()
	for _, leak := range []string{"argon2", "password_hash", "PasswordHash"} {
		if strings.Contains(body, leak) {
			t.Fatalf("the user list contains %q: %s", leak, body)
		}
	}
}

// Deleting the account you are signed in with is almost always a misclick and
// the recovery is unpleasant.
func TestAnAdminCannotDeleteTheirOwnAccount(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	token := h.seedAdmin(t)
	// A second admin, so the last-admin guard is not what refuses.
	h.login(t, "admin2", auth.RoleAdmin)

	me, err := h.store.GetUserByUsername(context.Background(), "root")
	if err != nil {
		t.Fatal(err)
	}
	w := h.do(t, "DELETE", "/api/v1/admin/users/"+me.UserID, "", token)
	if w.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409", w.Code)
	}
}

// The API's own last-admin guard has to hold at the HTTP layer too.
func TestDemotingTheLastAdminIs409(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	token := h.seedAdmin(t)
	me, _ := h.store.GetUserByUsername(context.Background(), "root")

	w := h.do(t, "PATCH", "/api/v1/admin/users/"+me.UserID, `{"role":"viewer"}`, token)
	if w.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409: %s", w.Code, w.Body)
	}
}

func TestChangingYourOwnPasswordNeedsTheCurrentOne(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	token := h.seedAdmin(t)

	w := h.do(t, "POST", "/api/v1/auth/password",
		`{"current_password":"wrong","new_password":"a brand new long passphrase"}`, token)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong current password = %d, want 401", w.Code)
	}

	w = h.do(t, "POST", "/api/v1/auth/password",
		`{"current_password":"`+testPassword+`","new_password":"a brand new long passphrase"}`, token)
	if w.Code != http.StatusNoContent {
		t.Fatalf("correct current password = %d: %s", w.Code, w.Body)
	}
	// The session that made the change survives.
	if w := h.do(t, "GET", "/api/v1/tracks", "", token); w.Code != http.StatusOK {
		t.Fatalf("the changing session was logged out: %d", w.Code)
	}
}

func TestSSOEndpointsSayWhenSSOIsNotConfigured(t *testing.T) {
	h := newAuthHarness(t, auth.ModeRequired)
	h.seedAdmin(t)

	for _, path := range []string{"/api/v1/auth/sso/start", "/api/v1/auth/sso/callback"} {
		w := h.do(t, "GET", path, "", "")
		if w.Code != http.StatusConflict {
			t.Errorf("GET %s = %d, want 409", path, w.Code)
		}
	}
}

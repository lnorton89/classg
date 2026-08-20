package httpapi

// Authentication at the HTTP edge: the cookie, the middleware, and the handful
// of endpoints that manage a session.
//
// The rule the routing table encodes: everything is closed unless it is
// explicitly opened. `protect` wraps a handler with a required role and is
// applied by default in routes(); the open set is small enough to read in one
// glance (health, the login endpoints, the setup endpoint, and the static web
// app). A new endpoint that forgets to say anything gets the default, which is
// "you must be logged in" -- the failure mode of forgetting is a locked door,
// not an open one.

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/auth"
)

// SessionCookie is the cookie name. The __Host- prefix would be stricter, but
// it requires Secure, and this box is routinely reached over plain HTTP on a
// LAN or a tailnet where there is no certificate. Secure is set when the
// request arrived over TLS -- see sessionCookie.
const SessionCookie = "classg_session"

type principalKey struct{}

// PrincipalFrom returns who made this request. The second result is false on an
// unauthenticated request, which only reaches a handler that allows it.
func PrincipalFrom(ctx context.Context) (auth.Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(auth.Principal)
	return p, ok
}

// protect requires a role. Wrap every handler that is not deliberately public.
func (s *Server) protect(need auth.Role, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.auth == nil || !s.auth.Enabled() {
			// ModeOff. Still attach a principal so handlers that log an action
			// can say "unauthenticated (auth disabled)" rather than inventing
			// a user.
			p, _ := s.auth.Authenticate(r.Context(), "")
			next(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
			return
		}

		// The local agent, before anything that touches the database. A
		// process on this unit's own host proves itself by reading a 0640 file
		// in the operator's state directory -- see auth.LocalAgent for why
		// that and not a loopback check. Viewer only, so this can never be a
		// way past the role gate below.
		//
		// Checked before NeedsSetup deliberately: on a unit with no accounts
		// the local agent still reads, which is the state pi-dash is most
		// useful in. It cannot create one -- setup is an unauthenticated route
		// of its own and does not come through here.
		if tok := bearerToken(r); s.localAgent.Matches(tok) {
			p := s.localAgent.Principal()
			if !p.User.Role.AtLeast(need) {
				fail(w, apierr.Forbidden("the local agent may only read; this needs the "+need.String()+" role"))
				return
			}
			next(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
			return
		}

		// A unit with no accounts serves nothing but setup. Answering 401 here
		// would send a browser to a login screen that cannot succeed.
		if needs, err := s.auth.NeedsSetup(r.Context()); err == nil && needs {
			fail(w, apierr.SetupRequired("this unit has no accounts yet; create the first administrator"))
			return
		}

		token := sessionToken(r)
		p, err := s.auth.Authenticate(r.Context(), token)
		switch {
		case err == nil:
		case errors.Is(err, auth.ErrNoSession), errors.Is(err, auth.ErrSessionExpired):
			clearSessionCookie(w, r)
			fail(w, apierr.Unauthenticated("log in to continue"))
			return
		case errors.Is(err, auth.ErrAccountDisabled):
			clearSessionCookie(w, r)
			fail(w, apierr.Forbidden("this account is disabled"))
			return
		default:
			fail(w, apierr.Internal("checking the session failed"))
			return
		}

		if !p.User.Role.AtLeast(need) {
			// 403, never 401. A viewer who clicks an admin link must stay
			// logged in; bouncing them to a login screen would look like their
			// session broke.
			fail(w, apierr.Forbidden("this action requires the "+need.String()+" role"))
			return
		}

		next(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
	}
}

// bearerToken reads `Authorization: Bearer <token>`.
//
// The browser never sends this header -- it carries a cookie. It is here for
// machine callers on this unit's own host, which have no cookie jar and no
// business borrowing a person's session.
func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	v := r.Header.Get("Authorization")
	if len(v) <= len(prefix) || !strings.EqualFold(v[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(v[len(prefix):])
}

func sessionToken(r *http.Request) string {
	c, err := r.Cookie(SessionCookie)
	if err != nil || c == nil {
		return ""
	}
	return c.Value
}

// requestIsTLS reports whether the client spoke TLS to something.
//
// X-Forwarded-Proto is honoured because the Compose layout puts Caddy in front.
// That header is only trustworthy behind a proxy that sets it, which is the
// deployment this is written for; the consequence of getting it wrong is a
// cookie marked Secure on a plain-HTTP connection, which fails closed (the
// browser stops sending it) rather than open.
func requestIsTLS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:  SessionCookie,
		Value: token,
		Path:  "/",
		// HttpOnly: the token is never readable from JavaScript, so an XSS in
		// the web app cannot walk off with a live session.
		HttpOnly: true,
		// Lax rather than Strict: Strict would drop the cookie on a top-level
		// navigation from an external link -- including the redirect back from
		// an SSO provider, which would break OIDC login outright.
		SameSite: http.SameSiteLaxMode,
		Secure:   requestIsTLS(r),
		MaxAge:   int(ttl.Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   requestIsTLS(r),
		MaxAge:   -1,
	})
}

// clientIP is best effort, for the session list only.
//
// Never used for a security decision, which is why trusting X-Forwarded-For is
// acceptable: the worst a forged one achieves is a misleading row in "active
// sessions". Anything that authorised on this would be trivially bypassed.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first, _, ok := strings.Cut(xff, ","); ok {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// --- endpoints -------------------------------------------------------------

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type meResponse struct {
	// Authenticated is false when auth is disabled, so the UI can show the
	// banner rather than pretending someone is logged in.
	Authenticated bool       `json:"authenticated"`
	AuthEnabled   bool       `json:"auth_enabled"`
	SetupRequired bool       `json:"setup_required"`
	User          *auth.User `json:"user,omitempty"`
	// Providers lists configured SSO issuers, so the login page knows whether
	// to draw the button.
	Providers []ssoProvider `json:"providers,omitempty"`
}

type ssoProvider struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// handleMe is what the web app calls on load to decide what to render.
//
// Deliberately public: it must answer before anyone is logged in, because its
// whole job is telling the client whether a login screen, a setup screen, or
// the app is the right thing to draw.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	resp := meResponse{AuthEnabled: s.auth != nil && s.auth.Enabled()}
	if s.oidc != nil && s.oidc.Configured() {
		resp.Providers = []ssoProvider{{ID: "oidc", Label: s.oidc.Label()}}
	}

	if !resp.AuthEnabled {
		writeJSON(w, http.StatusOK, resp)
		return
	}

	if needs, err := s.auth.NeedsSetup(r.Context()); err != nil {
		fail(w, apierr.Internal("checking setup state failed"))
		return
	} else if needs {
		resp.SetupRequired = true
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// The local agent answers here too, or a host tool would be authenticated
	// on every other endpoint while this one told it -- and the operator
	// reading its screen -- that nobody was logged in. A pane that contradicts
	// itself is worse than one that says nothing.
	if tok := bearerToken(r); s.localAgent.Matches(tok) {
		u := s.localAgent.Principal().User
		resp.Authenticated, resp.User = true, &u
		writeJSON(w, http.StatusOK, resp)
		return
	}

	p, err := s.auth.Authenticate(r.Context(), sessionToken(r))
	if err != nil {
		// Not an error response: "nobody is logged in" is a normal answer to
		// this question and the client acts on it by showing a login form.
		writeJSON(w, http.StatusOK, resp)
		return
	}
	u := p.User
	resp.Authenticated, resp.User = true, &u
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil || !s.auth.Enabled() {
		fail(w, apierr.Conflict("authentication is disabled on this unit"))
		return
	}
	var req loginRequest
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}

	u, token, err := s.auth.Login(r.Context(), req.Username, req.Password,
		r.UserAgent(), clientIP(r))
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrInvalidCredentials):
		// One message for both halves. Saying which was wrong turns a password
		// guess into a username oracle.
		fail(w, apierr.Unauthenticated("invalid username or password"))
		return
	case errors.Is(err, auth.ErrAccountDisabled):
		fail(w, apierr.Forbidden("this account is disabled"))
		return
	default:
		fail(w, apierr.Internal("login failed"))
		return
	}

	setSessionCookie(w, r, token, s.auth.TTL)
	writeJSON(w, http.StatusOK, meResponse{Authenticated: true, AuthEnabled: true, User: &u})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if s.auth != nil {
		if err := s.auth.Logout(r.Context(), sessionToken(r)); err != nil {
			fail(w, apierr.Internal("logout failed"))
			return
		}
	}
	clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

type setupRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
}

// handleSetup creates the first administrator.
//
// Public by necessity and closed the moment it succeeds. This exists so a
// freshly flashed unit does not ship a default password, which is the single
// most reliable way to end up with an internet-facing box running admin/admin.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil || !s.auth.Enabled() {
		fail(w, apierr.Conflict("authentication is disabled on this unit"))
		return
	}
	var req setupRequest
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}

	u, err := s.auth.Setup(r.Context(), req.Username, req.DisplayName, req.Password)
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrSetupComplete):
		fail(w, apierr.Conflict("this unit already has an administrator"))
		return
	case errors.Is(err, auth.ErrWeakPassword):
		fail(w, apierr.InvalidParameter("password", err.Error()))
		return
	case errors.Is(err, auth.ErrUserExists):
		fail(w, apierr.Conflict(err.Error()))
		return
	default:
		fail(w, apierr.InvalidParameter("username", err.Error()))
		return
	}

	// Log the new admin straight in. Making them immediately re-type the
	// password they just chose adds nothing.
	_, token, err := s.auth.Login(r.Context(), req.Username, req.Password, r.UserAgent(), clientIP(r))
	if err != nil {
		// The account exists; the login form will work. Say so rather than
		// implying setup failed.
		writeJSON(w, http.StatusCreated, meResponse{AuthEnabled: true, User: &u})
		return
	}
	setSessionCookie(w, r, token, s.auth.TTL)
	writeJSON(w, http.StatusCreated, meResponse{Authenticated: true, AuthEnabled: true, User: &u})
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// handleChangePassword changes the caller's own password.
//
// Requires the current one even though the caller is already authenticated: it
// is what stops a borrowed unlocked browser from becoming a permanent takeover.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok || p.Anonymous {
		fail(w, apierr.Conflict("authentication is disabled on this unit"))
		return
	}
	var req changePasswordRequest
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}
	if !p.User.HasPassword() || !auth.VerifyPassword(p.User.PasswordHash, req.CurrentPassword) {
		fail(w, apierr.Unauthenticated("current password is incorrect"))
		return
	}
	// keepSession: every OTHER session for this user is ended. A password
	// changed because it may have leaked is not changed at all if the browser
	// that leaked it stays logged in.
	if err := s.auth.SetPassword(r.Context(), p.User.UserID, req.NewPassword, p.SessionID); err != nil {
		if errors.Is(err, auth.ErrWeakPassword) {
			fail(w, apierr.InvalidParameter("new_password", err.Error()))
			return
		}
		fail(w, apierr.Internal("changing the password failed"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

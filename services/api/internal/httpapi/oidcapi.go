package httpapi

// The two endpoints an SSO login bounces through.
//
// Both are public: they have to work for someone who is not logged in, which is
// the entire point. The security lives in the state/nonce pair that
// internal/oidcauth mints and checks, not in who may call these.

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/oidcauth"
	"github.com/classg/api/internal/store"
)

func (s *Server) handleOIDCStart(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil || !s.oidc.Configured() {
		fail(w, apierr.Conflict("single sign-on is not configured on this unit"))
		return
	}
	url, err := s.oidc.AuthCodeURL(r.URL.Query().Get("return"))
	if err != nil {
		fail(w, apierr.Internal("starting single sign-on failed"))
		return
	}
	http.Redirect(w, r, url, http.StatusFound)
}

// handleOIDCCallback finishes the login and redirects into the app.
//
// Failures redirect to the login page with a reason in the query string rather
// than rendering a JSON envelope: the browser arrived here by following the
// provider's redirect, and a raw error document is a dead end for whoever is
// looking at it.
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil || !s.oidc.Configured() {
		fail(w, apierr.Conflict("single sign-on is not configured on this unit"))
		return
	}

	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		// The provider itself refused. Its wording is more useful than ours.
		redirectToLogin(w, r, e)
		return
	}

	id, err := s.oidc.Exchange(r.Context(), q.Get("state"), q.Get("code"))
	if err != nil {
		if errors.Is(err, oidcauth.ErrBadState) {
			redirectToLogin(w, r, "the login expired or did not match; try again")
			return
		}
		slog.Warn("single sign-on exchange failed", "err", err)
		redirectToLogin(w, r, "single sign-on failed")
		return
	}

	u, err := s.resolveSSOUser(r, id)
	if err != nil {
		if errors.Is(err, oidcauth.ErrNoAccount) {
			redirectToLogin(w, r, "no account on this unit is linked to that identity")
			return
		}
		if errors.Is(err, auth.ErrAccountDisabled) {
			redirectToLogin(w, r, "that account is disabled")
			return
		}
		slog.Error("resolving the single sign-on account failed", "err", err)
		redirectToLogin(w, r, "single sign-on failed")
		return
	}

	token, err := s.auth.StartSSOSession(r.Context(), u, r.UserAgent(), clientIP(r))
	if err != nil {
		slog.Error("starting the single sign-on session failed", "err", err)
		redirectToLogin(w, r, "single sign-on failed")
		return
	}
	setSessionCookie(w, r, token, s.auth.TTL)
	http.Redirect(w, r, id.Return, http.StatusFound)
}

// resolveSSOUser maps a verified identity onto a local account.
//
// Matched on (issuer, subject), never on email. Email is a claim a provider can
// change and, at some providers, one a user can set — matching on it would mean
// anyone who can set an email claim can become an existing operator. The
// subject is the provider's stable identifier for a person and is what it is
// for.
func (s *Server) resolveSSOUser(r *http.Request, id oidcauth.Identity) (auth.User, error) {
	ctx := r.Context()

	u, err := s.auth.Store.GetUserByOIDC(ctx, id.Issuer, id.Subject)
	switch {
	case err == nil:
		if u.Disabled {
			return auth.User{}, auth.ErrAccountDisabled
		}
		return u, nil
	case !errors.Is(err, store.ErrNotFound):
		return auth.User{}, err
	}

	// First login for this identity. If a local account already has the same
	// username, link them rather than creating a near-twin — but only if an
	// admin has opted into auto-provisioning, because linking is exactly the
	// step an attacker at the provider would want to happen automatically.
	auto, roleName := s.oidc.AutoProvision()
	if !auto {
		return auth.User{}, oidcauth.ErrNoAccount
	}
	role, err := auth.ParseRole(roleName)
	if err != nil {
		return auth.User{}, err
	}

	existing, err := s.auth.Store.GetUserByUsername(ctx, id.Username)
	if err == nil {
		if existing.Issuer != "" {
			// Already linked to a different provider identity. Refuse rather
			// than reassign: this is either a misconfiguration or someone
			// trying to take over an account.
			return auth.User{}, oidcauth.ErrNoAccount
		}
		// Never auto-link into MORE than auto-provisioning would grant. The
		// username claim is user-settable at some providers, so "an unlinked
		// local account with the same name" describes exactly the account an
		// attacker would name themselves after -- and this link used to hand
		// over that account's role, admin included, bypassing the configured
		// CLASSG_OIDC_ROLE tier. Linking an account at or below the tier is
		// still allowed; anything above it needs an admin to link by hand.
		if !role.AtLeast(existing.Role) {
			return auth.User{}, oidcauth.ErrNoAccount
		}
		existing.Issuer, existing.Subject = id.Issuer, id.Subject
		if existing.DisplayName == "" {
			existing.DisplayName = id.Name
		}
		existing.UpdatedAt = s.auth.NowOrDefault()
		if err := s.auth.Store.PutUser(ctx, existing); err != nil {
			return auth.User{}, err
		}
		return existing, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return auth.User{}, err
	}

	return s.auth.CreateSSOUser(ctx, id.Issuer, id.Subject, id.Username, id.Name, role)
}

func redirectToLogin(w http.ResponseWriter, r *http.Request, reason string) {
	http.Redirect(w, r, "/login?error="+url.QueryEscape(reason), http.StatusFound)
}

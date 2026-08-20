// Package oidcauth is Single Sign-On over OpenID Connect.
//
// One generic provider rather than per-vendor integrations. Google, Authentik,
// Keycloak, Entra and Okta all speak OIDC discovery, so a client id, a secret
// and an issuer URL is the whole configuration -- and a vendor-shaped
// integration would be five code paths that all had to be kept working against
// APIs nobody here can test.
//
// go-oidc does the token validation. That is deliberate rather than lazy: ID
// token verification means JWKS fetching and rotation, signature checks,
// issuer/audience/expiry validation and nonce binding, and hand-rolled versions
// of that are a well-populated category of security bug.
//
// SSO does not create accounts by default. A provider that will issue a token
// to anyone with a Google account would otherwise turn "SSO configured" into
// "anyone on the internet is an operator". Auto-provisioning is opt-in, and
// even then it grants the lowest role.
package oidcauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

var (
	ErrNotConfigured = errors.New("SSO is not configured on this unit")
	// ErrNoAccount is a valid login at the provider for whom no local account
	// exists and auto-provisioning is off.
	ErrNoAccount = errors.New("no account on this unit is linked to that identity")
	ErrBadState  = errors.New("the login did not complete; start again")
)

// Config is the whole of it.
type Config struct {
	// IssuerURL is the discovery root, e.g. https://accounts.google.com.
	IssuerURL    string
	ClientID     string
	ClientSecret string
	// RedirectURL must exactly match what is registered at the provider.
	RedirectURL string
	// Label is what the login button says.
	Label string
	// Scopes beyond openid/profile/email.
	Scopes []string
	// AutoProvision creates an account on first successful login. Off by
	// default: see the package comment.
	AutoProvision bool
	// AutoProvisionRole is what such an account gets. Never admin, and the
	// constructor refuses to make it admin.
	AutoProvisionRole string
	// UsernameClaim picks the local username. `preferred_username` where the
	// provider sets it, `email` otherwise.
	UsernameClaim string
}

// Provider wraps a configured issuer.
type Provider struct {
	cfg      Config
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth    *oauth2.Config

	mu    sync.Mutex
	flows map[string]flow
}

// flow is one login in progress.
//
// Kept in memory rather than the database: these live for the seconds between
// the redirect out and the redirect back, and a restart mid-login is a login
// the user retries. Persisting them would mean a table that is empty 99.99% of
// the time and a purge job for the rest.
type flow struct {
	nonce     string
	expiresAt time.Time
	// Return is where to send the browser afterwards. Validated to a relative
	// path at creation -- an open redirect on a login callback is how a
	// phishing page borrows a real login screen.
	Return string
}

const flowTTL = 10 * time.Minute

// New builds a provider, or nil when SSO is not configured.
//
// Discovery happens here, which means a wrong issuer URL fails at startup with
// a clear message rather than on someone's first login attempt.
func New(ctx context.Context, cfg Config) (*Provider, error) {
	if strings.TrimSpace(cfg.IssuerURL) == "" {
		return nil, nil
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, errors.New("SSO needs a client id and secret as well as an issuer URL")
	}
	if cfg.RedirectURL == "" {
		return nil, errors.New("SSO needs a redirect URL, and it must match the one registered at the provider")
	}
	if strings.EqualFold(cfg.AutoProvisionRole, "admin") {
		// Refused outright. Auto-provisioning admins means whoever controls
		// the identity provider silently controls this unit.
		return nil, errors.New("SSO auto-provisioning may not grant the admin role")
	}

	// Discovery talks to the network; bound it so a wrong or unreachable
	// issuer does not hang startup.
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	p, err := oidc.NewProvider(dctx, strings.TrimRight(cfg.IssuerURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery against %s failed: %w", cfg.IssuerURL, err)
	}

	scopes := append([]string{oidc.ScopeOpenID, "profile", "email"}, cfg.Scopes...)
	return &Provider{
		cfg:      cfg,
		provider: p,
		verifier: p.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		oauth: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint:     p.Endpoint(),
			RedirectURL:  cfg.RedirectURL,
			Scopes:       scopes,
		},
		flows: map[string]flow{},
	}, nil
}

func (p *Provider) Configured() bool { return p != nil && p.provider != nil }

func (p *Provider) Label() string {
	if p == nil {
		return ""
	}
	if p.cfg.Label != "" {
		return p.cfg.Label
	}
	return "Single sign-on"
}

func (p *Provider) AutoProvision() (bool, string) {
	if p == nil {
		return false, ""
	}
	role := p.cfg.AutoProvisionRole
	if role == "" {
		role = "viewer"
	}
	return p.cfg.AutoProvision, role
}

// AuthCodeURL starts a login.
//
// state is a random value bound to a nonce; both are checked on the way back.
// state defeats CSRF on the callback, nonce binds the ID token to this specific
// request so one captured elsewhere cannot be replayed here.
func (p *Provider) AuthCodeURL(returnTo string) (string, error) {
	if !p.Configured() {
		return "", ErrNotConfigured
	}
	state, err := randomToken()
	if err != nil {
		return "", err
	}
	nonce, err := randomToken()
	if err != nil {
		return "", err
	}

	p.mu.Lock()
	p.sweepLocked()
	p.flows[state] = flow{
		nonce:     nonce,
		expiresAt: time.Now().Add(flowTTL),
		Return:    safeReturn(returnTo),
	}
	p.mu.Unlock()

	return p.oauth.AuthCodeURL(state, oidc.Nonce(nonce)), nil
}

// safeReturn keeps a post-login redirect inside this app.
//
// Anything that is not a single-slash-prefixed relative path becomes "/". A
// callback that will redirect anywhere is an open redirect, and an open
// redirect on a login endpoint is exactly what a phishing page wants: a real
// login screen on the real domain that lands the victim somewhere else.
func safeReturn(s string) string {
	if s == "" || !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") {
		return "/"
	}
	// A backslash is a forward slash to a browser. The WHATWG URL parser
	// normalises it for special schemes, so "/\evil.example" resolves exactly
	// as "//evil.example" does -- protocol-relative, off this origin, and past
	// the check above, which only looks for the slash spelling. Chrome and
	// Firefox both do this.
	if strings.Contains(s, "\\") {
		return "/"
	}
	// Control characters have no business in a path and every business in a
	// Location header: some parsers strip them before resolving, so a path
	// containing a tab or newline can become protocol-relative after the
	// check above has already passed it.
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return "/"
		}
	}
	return s
}

// Identity is what came back from the provider.
type Identity struct {
	Issuer   string
	Subject  string
	Username string
	Name     string
	Email    string
	Return   string
	// UsernameFromEmail records that Username was derived from the email
	// claim, which happens under CLASSG_OIDC_USERNAME_CLAIM=email and also by
	// default when the provider sends no preferred_username.
	UsernameFromEmail bool
	// EmailVerified is the provider's own email_verified claim, absent
	// counting as false. It was decoded and discarded before: an unverified
	// email is a string the user typed, and this identity's username may be
	// that string. resolveSSOUser is what acts on it.
	EmailVerified bool
}

// Exchange completes a login.
func (p *Provider) Exchange(ctx context.Context, state, code string) (Identity, error) {
	if !p.Configured() {
		return Identity{}, ErrNotConfigured
	}

	p.mu.Lock()
	f, ok := p.flows[state]
	// Single use, whatever happens next: a state that could be replayed is not
	// a defence against replay.
	delete(p.flows, state)
	p.sweepLocked()
	p.mu.Unlock()

	if !ok || time.Now().After(f.expiresAt) {
		return Identity{}, ErrBadState
	}

	token, err := p.oauth.Exchange(ctx, code)
	if err != nil {
		return Identity{}, fmt.Errorf("exchanging the authorization code failed: %w", err)
	}
	rawID, ok := token.Extra("id_token").(string)
	if !ok {
		return Identity{}, errors.New("the provider returned no id_token")
	}
	idToken, err := p.verifier.Verify(ctx, rawID)
	if err != nil {
		return Identity{}, fmt.Errorf("the id_token did not verify: %w", err)
	}
	if idToken.Nonce != f.nonce {
		// The token is validly signed but belongs to a different login.
		return Identity{}, ErrBadState
	}

	var claims struct {
		Sub               string `json:"sub"`
		Email             string `json:"email"`
		EmailVerified     bool   `json:"email_verified"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return Identity{}, fmt.Errorf("reading id_token claims failed: %w", err)
	}

	username, fromEmail := p.pickUsername(claims.PreferredUsername, claims.Email, claims.Sub)
	if username == "" {
		return Identity{}, errors.New("the provider returned no usable username claim")
	}

	return Identity{
		Issuer:            idToken.Issuer,
		Subject:           claims.Sub,
		Username:          username,
		Name:              claims.Name,
		Email:             claims.Email,
		Return:            f.Return,
		UsernameFromEmail: fromEmail,
		EmailVerified:     claims.EmailVerified,
	}, nil
}

// pickUsername returns the local username and whether it came from the email
// claim. The second return is not bookkeeping: an email a provider has not
// verified is a string the user typed, so a username derived from one names
// whoever the user chose to name.
func (p *Provider) pickUsername(preferred, email, sub string) (string, bool) {
	switch p.cfg.UsernameClaim {
	case "email":
		return strings.ToLower(email), true
	case "sub":
		return sub, false
	case "preferred_username":
		return strings.ToLower(preferred), false
	}
	if preferred != "" {
		return strings.ToLower(preferred), false
	}
	return strings.ToLower(email), true
}

// sweepLocked drops expired flows. Caller holds the lock.
func (p *Provider) sweepLocked() {
	now := time.Now()
	for k, f := range p.flows {
		if now.After(f.expiresAt) {
			delete(p.flows, k)
		}
	}
}

func randomToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating a login token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// HTTPClientContext lets a caller supply the client used for discovery and
// token exchange -- needed where egress goes through a proxy.
func HTTPClientContext(ctx context.Context, c *http.Client) context.Context {
	return oidc.ClientContext(ctx, c)
}

package httpapi

// The admin surface: accounts and live sessions.
//
// Every handler here is behind protect(auth.RoleAdmin) in routes(). Nothing in
// this file re-checks that, deliberately -- a second check in the handler would
// be the kind of belt-and-braces that makes people relax about the belt.
//
// One rule with teeth: a password hash never appears in a response. auth.User
// tags it `json:"-"`, which handles the accidental case; the deliberate case is
// that no handler here reaches for it.

import (
	"errors"
	"net/http"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/store"
)

type usersResponse struct {
	Users []auth.User `json:"users"`
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.auth.Store.ListUsers(r.Context())
	if err != nil {
		fail(w, apierr.Internal("listing users failed"))
		return
	}
	if users == nil {
		users = []auth.User{}
	}
	writeJSON(w, http.StatusOK, usersResponse{Users: users})
}

type createUserRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Role        string `json:"role"`
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req createUserRequest
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}
	role, err := auth.ParseRole(req.Role)
	if err != nil {
		fail(w, apierr.InvalidParameter("role", err.Error()))
		return
	}

	u, err := s.auth.CreateUser(r.Context(), req.Username, req.DisplayName, req.Password, role)
	switch {
	case err == nil:
		writeJSON(w, http.StatusCreated, u)
	case errors.Is(err, auth.ErrUserExists):
		fail(w, apierr.Conflict(err.Error()))
	case errors.Is(err, auth.ErrWeakPassword):
		fail(w, apierr.InvalidParameter("password", err.Error()))
	default:
		fail(w, apierr.InvalidParameter("username", err.Error()))
	}
}

type updateUserRequest struct {
	// Pointers: absent means "leave it alone", which is what makes this a
	// PATCH. A plain string could not distinguish "clear the display name"
	// from "I did not mention the display name".
	Role        *string `json:"role"`
	DisplayName *string `json:"display_name"`
	Disabled    *bool   `json:"disabled"`
	Password    *string `json:"password"`
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("user_id")
	var req updateUserRequest
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}

	var role *auth.Role
	if req.Role != nil {
		parsed, err := auth.ParseRole(*req.Role)
		if err != nil {
			fail(w, apierr.InvalidParameter("role", err.Error()))
			return
		}
		role = &parsed
	}

	u, err := s.auth.UpdateUser(r.Context(), id, role, req.DisplayName, req.Disabled)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrNotFound):
		fail(w, apierr.NotFound("no user with id "+id))
		return
	case errors.Is(err, auth.ErrLastAdmin):
		// Conflict, not forbidden: the caller has every right to do this, the
		// system state is what refuses. Demoting the only admin leaves a box
		// recoverable only by editing the database by hand.
		fail(w, apierr.Conflict(err.Error()))
		return
	default:
		fail(w, apierr.Internal("updating the user failed"))
		return
	}

	// An admin resetting someone else's password does not need the old one --
	// that is the point of a reset. Every session for that user ends, because
	// a reset that leaves the old browser logged in has reset nothing.
	if req.Password != nil {
		if err := s.auth.SetPassword(r.Context(), id, *req.Password, ""); err != nil {
			if errors.Is(err, auth.ErrWeakPassword) {
				fail(w, apierr.InvalidParameter("password", err.Error()))
				return
			}
			fail(w, apierr.Internal("setting the password failed"))
			return
		}
	}

	writeJSON(w, http.StatusOK, u)
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("user_id")

	// Deleting yourself is refused. It is almost always a misclick, the
	// recovery is unpleasant, and "disable" is what someone actually wants.
	if p, ok := PrincipalFrom(r.Context()); ok && p.User.UserID == id {
		fail(w, apierr.Conflict("you cannot delete the account you are signed in with"))
		return
	}

	err := s.auth.DeleteUser(r.Context(), id)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrNotFound):
		fail(w, apierr.NotFound("no user with id "+id))
	case errors.Is(err, auth.ErrLastAdmin):
		fail(w, apierr.Conflict(err.Error()))
	default:
		fail(w, apierr.Internal("deleting the user failed"))
	}
}

type sessionOut struct {
	auth.Session
	// Username is joined in so the list is readable without a second call.
	Username string `json:"username"`
	// Current marks the caller's own session, so an admin killing sessions can
	// see which row is the browser they are sitting in front of.
	Current bool `json:"current"`
}

type sessionsResponse struct {
	Sessions []sessionOut `json:"sessions"`
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.auth.Store.ListSessions(r.Context(), 500)
	if err != nil {
		fail(w, apierr.Internal("listing sessions failed"))
		return
	}
	users, err := s.auth.Store.ListUsers(r.Context())
	if err != nil {
		fail(w, apierr.Internal("listing users failed"))
		return
	}
	byID := make(map[string]string, len(users))
	for _, u := range users {
		byID[u.UserID] = u.Username
	}

	me, _ := PrincipalFrom(r.Context())
	out := make([]sessionOut, 0, len(sessions))
	for _, sess := range sessions {
		out = append(out, sessionOut{
			Session:  sess,
			Username: byID[sess.UserID],
			Current:  sess.SessionID == me.SessionID,
		})
	}
	writeJSON(w, http.StatusOK, sessionsResponse{Sessions: out})
}

// handleRevokeSession ends one session by id.
func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("session_id")
	err := s.auth.Store.DeleteSession(r.Context(), id)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrNotFound):
		fail(w, apierr.NotFound("no session with that id"))
	default:
		fail(w, apierr.Internal("revoking the session failed"))
	}
}

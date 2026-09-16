package httpapi

// Geofence boundaries: named polygons a hook rule can require a track's
// position to fall inside.
//
// Admin-only, all of it, and not merely by analogy with hooks: a boundary an
// operator draws is very often their own property outline, which is home
// address in every way that matters. It gets no less protection than the
// operator ground position that CLASSG_EXPOSE_OPERATOR_LOCATION gates.

import (
	"errors"
	"net/http"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/geofence"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/ulid"
)

type boundariesResponse struct {
	Boundaries []geofence.Boundary `json:"boundaries"`
}

func (s *Server) handleListBoundaries(w http.ResponseWriter, r *http.Request) {
	boundaries, err := s.store.ListBoundaries(r.Context())
	if err != nil {
		fail(w, apierr.Internal("listing boundaries failed"))
		return
	}
	if boundaries == nil {
		boundaries = []geofence.Boundary{}
	}
	writeJSON(w, http.StatusOK, boundariesResponse{Boundaries: boundaries})
}

func (s *Server) handleCreateBoundary(w http.ResponseWriter, r *http.Request) {
	var b geofence.Boundary
	if err := decodeBody(r, &b); err != nil {
		fail(w, err)
		return
	}

	b.BoundaryID = ulid.New(s.now())
	b.CreatedAt, b.UpdatedAt = s.now(), s.now()

	if err := b.Validate(); err != nil {
		fail(w, apierr.InvalidParameter("points", err.Error()))
		return
	}
	if err := s.store.PutBoundary(r.Context(), b); err != nil {
		fail(w, apierr.Internal("saving the boundary failed"))
		return
	}
	s.invalidateBoundaries()
	writeJSON(w, http.StatusCreated, b)
}

// invalidateBoundaries tells the dispatcher its cached boundary list is
// stale. Every admin write path must call this, or a redrawn property line
// sits inert until the cache TTL -- an admin who just fixed a boundary would
// keep seeing the old one used and reasonably conclude the edit did not save.
func (s *Server) invalidateBoundaries() {
	if s.hooks != nil {
		s.hooks.InvalidateBoundaries()
	}
}

func (s *Server) handleUpdateBoundary(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("boundary_id")

	existing, err := s.store.GetBoundary(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no boundary with id "+id))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("reading the boundary failed"))
		return
	}

	var incoming geofence.Boundary
	if err := decodeBody(r, &incoming); err != nil {
		fail(w, err)
		return
	}
	incoming.BoundaryID = existing.BoundaryID
	incoming.CreatedAt = existing.CreatedAt
	incoming.UpdatedAt = s.now()

	if err := incoming.Validate(); err != nil {
		fail(w, apierr.InvalidParameter("points", err.Error()))
		return
	}
	if err := s.store.PutBoundary(r.Context(), incoming); err != nil {
		fail(w, apierr.Internal("saving the boundary failed"))
		return
	}
	s.invalidateBoundaries()
	writeJSON(w, http.StatusOK, incoming)
}

func (s *Server) handleDeleteBoundary(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("boundary_id")

	// Refused rather than silently orphaned: a rule left pointing at a
	// deleted boundary never matches again, which looks identical from the
	// outside to "no drone has entered the fence yet" -- exactly the failure
	// mode ValidateRule's existence check exists to catch at save time, and
	// deleting out from under a saved rule is the other way into it.
	rules, err := s.store.ListHookRules(r.Context())
	if err != nil {
		fail(w, apierr.Internal("checking whether the boundary is in use failed"))
		return
	}
	for _, rule := range rules {
		if rule.BoundaryID == id {
			fail(w, apierr.Conflict(
				"rule "+rule.Name+" uses this boundary; change or delete that rule first"))
			return
		}
	}

	err = s.store.DeleteBoundary(r.Context(), id)
	switch {
	case err == nil:
		s.invalidateBoundaries()
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrNotFound):
		fail(w, apierr.NotFound("no boundary with id "+id))
	default:
		fail(w, apierr.Internal("deleting the boundary failed"))
	}
}

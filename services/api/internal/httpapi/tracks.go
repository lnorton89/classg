package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

type tracksResponse struct {
	Tracks     []model.Track `json:"tracks"`
	NextCursor *string       `json:"next_cursor"`
	Total      int           `json:"total"`
}

func (s *Server) handleListTracks(w http.ResponseWriter, r *http.Request) {
	states, err := csvParam(r, "state", model.TrackStates)
	if err != nil {
		fail(w, err)
		return
	}
	since, err := timeParam(r, "since")
	if err != nil {
		fail(w, err)
		return
	}
	minConfidence, err := floatParam(r, "min_confidence", 0, 1)
	if err != nil {
		fail(w, err)
		return
	}
	limit, err := limitParam(r)
	if err != nil {
		fail(w, err)
		return
	}
	cursor, err := cursorParam(r)
	if err != nil {
		fail(w, err)
		return
	}

	page, err := s.store.ListTracks(r.Context(), store.TrackQuery{
		States:        states,
		Since:         since,
		MinConfidence: minConfidence,
		Limit:         limit,
		Cursor:        cursor,
	})
	if err != nil {
		fail(w, apierr.Internal("listing tracks failed"))
		return
	}

	writeJSON(w, http.StatusOK, tracksResponse{
		Tracks:     model.RedactTracks(page.Tracks, s.cfg.ExposeOperatorLocation),
		NextCursor: nullableString(page.NextCursor),
		Total:      page.Total,
	})
}

func (s *Server) handleGetTrack(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("track_id")
	t, err := s.store.GetTrack(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no track with id "+id))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("loading track failed"))
		return
	}
	writeJSON(w, http.StatusOK, t.Redact(s.cfg.ExposeOperatorLocation))
}

func (s *Server) handleTrackDetections(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("track_id")
	t, err := s.store.GetTrack(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no track with id "+id))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("loading track failed"))
		return
	}
	limit, err := limitParam(r)
	if err != nil {
		fail(w, err)
		return
	}
	cursor, err := cursorParam(r)
	if err != nil {
		fail(w, err)
		return
	}
	since, err := timeParam(r, "since")
	if err != nil {
		fail(w, err)
		return
	}

	from := t.FirstSeen
	if !since.IsZero() && since.After(from) {
		from = since
	}
	// A small grace window on the upper bound: a detection can be written by
	// the sensor path microseconds after the track update that it produced,
	// and excluding it would make the last detection of every track invisible.
	to := t.LastSeen.Add(time.Second)

	page, err := s.store.ListTrackDetections(r.Context(), store.TrackDetectionQuery{
		Serial: t.Identity.Serial,
		MACs:   t.Identity.MACs,
		From:   from,
		To:     to,
		Limit:  limit,
		Cursor: cursor,
	})
	if err != nil {
		fail(w, apierr.Internal("listing detections failed"))
		return
	}
	writeJSON(w, http.StatusOK, detectionsResponse{
		Detections: model.RedactDetections(page.Detections, s.cfg.ExposeOperatorLocation),
		NextCursor: nullableString(page.NextCursor),
		Total:      page.Total,
	})
}

// nullableString renders an absent cursor as JSON null, which is what the
// contract's example shows, rather than as an empty string.
func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

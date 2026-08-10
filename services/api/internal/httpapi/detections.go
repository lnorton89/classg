package httpapi

import (
	"net/http"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

type detectionsResponse struct {
	Detections []model.Detection `json:"detections"`
	NextCursor *string           `json:"next_cursor"`
	Total      int               `json:"total"`
}

func (s *Server) handleListDetections(w http.ResponseWriter, r *http.Request) {
	classes, err := csvParam(r, "class", model.DetectionClasses)
	if err != nil {
		fail(w, err)
		return
	}
	since, err := timeParam(r, "since")
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

	page, err := s.store.ListDetections(r.Context(), store.DetectionQuery{
		Classes:  classes,
		SensorID: r.URL.Query().Get("sensor_id"),
		Since:    since,
		Limit:    limit,
		Cursor:   cursor,
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

package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/store"
)

// Per-aircraft labels: a free-text name and a triage flag, keyed by the
// broadcast serial. See docs/research/08-tracks-ux.md, "Labels per aircraft".
//
// A label is a note and nothing more. Nothing in the detection path reads it,
// and `ignore` does not stop a track being recorded -- ClassG is receive-only
// and this annotates what was heard rather than changing what is listened for.

// maxLabelLength bounds what the operator can type. Long enough for
// "Neighbour's Mini 4 Pro, flies most evenings", short enough that the Tracks
// list's group header cannot be pushed off the row by one pasted paragraph.
const maxLabelLength = 120

// maxSerialLength is a sanity bound on the path segment, not a protocol rule.
// ANSI/CTA-2063-A serials are 20 characters; the slack is for the malformed
// ones real airframes broadcast. Without a cap, the labels table is an
// unbounded key-value store for anyone with the operator role.
const maxSerialLength = 64

type aircraftLabelsResponse struct {
	Labels []store.AircraftLabel `json:"labels"`
}

type aircraftLabelRequest struct {
	Label string `json:"label"`
	Flag  string `json:"flag"`
}

func (s *Server) handleListAircraftLabels(w http.ResponseWriter, r *http.Request) {
	labels, err := s.store.ListAircraftLabels(r.Context())
	if err != nil {
		fail(w, apierr.Internal("listing aircraft labels failed"))
		return
	}
	// The stores both order by serial, but the whole set is small enough that
	// asserting it here costs nothing and keeps the response diffable however
	// a future store answers.
	sort.Slice(labels, func(i, j int) bool { return labels[i].Serial < labels[j].Serial })
	writeJSON(w, http.StatusOK, aircraftLabelsResponse{Labels: labels})
}

func (s *Server) handleGetAircraftLabel(w http.ResponseWriter, r *http.Request) {
	serial, err := aircraftSerial(r)
	if err != nil {
		fail(w, err)
		return
	}
	l, err := s.store.GetAircraftLabel(r.Context(), serial)
	if errors.Is(err, store.ErrNotFound) {
		// 404 rather than an empty label: "this aircraft has no label" and
		// "this aircraft is labelled with the empty string" are different
		// answers, and the second one is reachable by clearing only the flag.
		fail(w, apierr.NotFound("no label for serial "+serial))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("loading the aircraft label failed"))
		return
	}
	writeJSON(w, http.StatusOK, l)
}

// handlePutAircraftLabel sets or clears one aircraft's label.
//
// An empty label with an empty flag deletes the row rather than storing a
// blank one. Otherwise clearing a label would leave behind a record that lists
// as a labelled aircraft with nothing to show, and the UI would have to
// special-case it on the way out instead.
func (s *Server) handlePutAircraftLabel(w http.ResponseWriter, r *http.Request) {
	serial, err := aircraftSerial(r)
	if err != nil {
		fail(w, err)
		return
	}
	var body aircraftLabelRequest
	if err := decodeBody(r, &body); err != nil {
		fail(w, err)
		return
	}

	label := strings.TrimSpace(body.Label)
	if len(label) > maxLabelLength {
		fail(w, apierr.InvalidParameter("label",
			"label must be at most "+strconv.Itoa(maxLabelLength)+" characters"))
		return
	}
	flag := strings.TrimSpace(body.Flag)
	if !store.AircraftFlags[flag] {
		// Named values, not a shrug: a typo'd flag that was accepted would
		// render as a blank badge and look like the feature was broken.
		fail(w, apierr.InvalidParameter("flag",
			"flag must be one of known, watch, ignore, or empty to clear it"))
		return
	}

	if label == "" && flag == "" {
		if err := s.store.DeleteAircraftLabel(r.Context(), serial); err != nil {
			fail(w, apierr.Internal("clearing the aircraft label failed"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	l := store.AircraftLabel{
		Serial:    serial,
		Label:     label,
		Flag:      flag,
		UpdatedAt: s.now(),
	}
	if err := s.store.PutAircraftLabel(r.Context(), l); err != nil {
		fail(w, apierr.Internal("saving the aircraft label failed"))
		return
	}
	writeJSON(w, http.StatusOK, l)
}

// aircraftSerial reads and bounds the {serial} path segment. ServeMux has
// already URL-decoded it.
func aircraftSerial(r *http.Request) (string, error) {
	serial := strings.TrimSpace(r.PathValue("serial"))
	if serial == "" {
		return "", apierr.InvalidParameter("serial", "serial is required")
	}
	if len(serial) > maxSerialLength {
		return "", apierr.InvalidParameter("serial",
			"serial must be at most "+strconv.Itoa(maxSerialLength)+" characters")
	}
	return serial, nil
}

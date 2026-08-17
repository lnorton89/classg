package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/spectrum"
	"github.com/classg/api/internal/store"
)

// The spectrum endpoints expose ENERGY measurements. A peak above threshold
// means something is transmitting; it never means a drone. The detector that
// could tell those apart is Milestone 3, it needs a test transmitter to
// validate against, and until it exists these responses must not grow a field
// that implies a classification.

type bandsResponse struct {
	Bands []spectrum.Band `json:"bands"`
	// Available is false on a machine that cannot sweep -- no sensor binary, or
	// one built without the `rtlsdr` feature. Reason says which, because
	// "sweeping is unavailable" with no cause sends an operator to the wrong
	// place (ADR-0003).
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// RunningSweepID is non-empty while the radio is taken.
	RunningSweepID string `json:"running_sweep_id,omitempty"`
}

func (s *Server) handleListBands(w http.ResponseWriter, r *http.Request) {
	if s.spectrum == nil {
		writeJSON(w, http.StatusOK, bandsResponse{
			Bands:     []spectrum.Band{},
			Available: false,
			Reason:    "no sweep engine configured",
		})
		return
	}

	resp := bandsResponse{Bands: []spectrum.Band{}, RunningSweepID: s.spectrum.Running()}

	bands, err := s.spectrum.Bands(r.Context())
	if err != nil {
		// Not an error response. A unit with no SDR attached is a working unit
		// with one fewer sensor, and the picker should say so rather than the
		// page failing to load.
		resp.Reason = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.Bands, resp.Available = bands, true
	writeJSON(w, http.StatusOK, resp)
}

type startSweepRequest struct {
	Band string `json:"band"`
}

type sweepsResponse struct {
	Sweeps []model.SpectrumSweep `json:"sweeps"`
}

func (s *Server) handleListSweeps(w http.ResponseWriter, r *http.Request) {
	limit, perr := intParam(r, "limit", 50, 500)
	if perr != nil {
		fail(w, perr)
		return
	}
	list, err := s.store.ListSweeps(r.Context(), limit)
	if err != nil {
		fail(w, apierr.Internal("listing sweeps failed"))
		return
	}
	if list == nil {
		list = []model.SpectrumSweep{}
	}
	writeJSON(w, http.StatusOK, sweepsResponse{Sweeps: list})
}

// handleStartSweep takes the radio and measures one band.
//
// This is deliberately operator-initiated rather than continuous. dump1090 owns
// the dongle on a working unit (ADR-0008), so a live waterfall would mean
// permanent ADS-B blindness; a sweep instead borrows the radio for one band and
// gives it back. The cost is real and belongs to whoever pressed the button.
func (s *Server) handleStartSweep(w http.ResponseWriter, r *http.Request) {
	if s.spectrum == nil {
		fail(w, apierr.SensorUnavailable("no sweep engine is configured on this unit"))
		return
	}

	var req startSweepRequest
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}

	sweep, err := s.spectrum.Start(r.Context(), req.Band)
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, sweep)
	case errors.Is(err, spectrum.ErrUnknownBand):
		fail(w, apierr.InvalidParameter("band", err.Error()))
	case errors.Is(err, spectrum.ErrBusy), errors.Is(err, spectrum.ErrRadioBusy):
		// 409, not 503: nothing is broken. The radio is doing its other job.
		fail(w, apierr.Conflict(err.Error()))
	case errors.Is(err, spectrum.ErrUnavailable):
		fail(w, apierr.SensorUnavailable(err.Error()))
	default:
		fail(w, apierr.Internal("starting the sweep failed: "+err.Error()))
	}
}

type sweepDetailResponse struct {
	model.SpectrumSweep
	// Trace is the whole band as one line, DC guards removed and overlapping
	// steps max-held. Absent while a sweep is running and on one that failed.
	Trace *spectrum.Trace `json:"trace,omitempty"`
	// Steps carries each tune step's own peak, which the trace flattens away.
	Steps []sweepStepOut `json:"step_peaks,omitempty"`
}

type sweepStepOut struct {
	CenterHz int64    `json:"center_hz"`
	PeakHz   *float64 `json:"peak_hz"`
	PeakDBFS *float64 `json:"peak_dbfs"`
}

func (s *Server) handleGetSweep(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("sweep_id")

	sweep, err := s.store.GetSweep(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no sweep with id "+id))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("reading the sweep failed"))
		return
	}

	resp := sweepDetailResponse{SpectrumSweep: sweep}

	bins, err := s.store.GetSweepBins(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		// Running, or failed. The record is the answer; there is no
		// measurement, and an empty trace would chart as a flat quiet band.
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if err != nil {
		fail(w, apierr.Internal("reading the measurement failed"))
		return
	}

	doc, err := spectrum.ParseDoc(bins)
	if err != nil {
		fail(w, apierr.Internal("the stored measurement did not decode: "+err.Error()))
		return
	}

	width, perr := intParam(r, "bins", spectrum.DefaultTraceWidth, spectrum.MaxTraceWidth)
	if perr != nil {
		fail(w, perr)
		return
	}

	trace := spectrum.Stitch(doc, width)
	resp.Trace = &trace
	resp.Steps = make([]sweepStepOut, 0, len(doc.Steps))
	for _, st := range doc.Steps {
		resp.Steps = append(resp.Steps, sweepStepOut{
			CenterHz: st.CenterHz,
			PeakHz:   st.PeakHz,
			PeakDBFS: st.PeakDBFS,
		})
	}

	writeJSON(w, http.StatusOK, resp)
}

// intParam reads a bounded positive integer query parameter.
func intParam(r *http.Request, name string, def, max int) (int, *apierr.Error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0, apierr.InvalidParameter(name, name+" must be a positive integer")
	}
	if v > max {
		return 0, apierr.InvalidParameter(name,
			name+" must be at most "+strconv.Itoa(max))
	}
	return v, nil
}

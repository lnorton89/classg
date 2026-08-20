package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

type capturesResponse struct {
	Captures []model.Capture `json:"captures"`
}

func (s *Server) handleListCaptures(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListCaptures(r.Context())
	if err != nil {
		fail(w, apierr.Internal("listing captures failed"))
		return
	}
	if list == nil {
		list = []model.Capture{}
	}
	writeJSON(w, http.StatusOK, capturesResponse{Captures: list})
}

func (s *Server) handleGetCapture(w http.ResponseWriter, r *http.Request) {
	c, err := s.captureOr404(w, r)
	if err != nil {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// captureIfaces is the set of interfaces a capture request may name.
//
// The gate this backs is not about validity -- capture.Validate already
// rejects anything that is not an interface name -- it is about a browser not
// being able to point tcpdump at an arbitrary device on the host. That still
// holds here: the set is the unit's own configured interface plus whichever
// interfaces its Wi-Fi sensors report reading, and nothing a client sends can
// add to it.
//
// It was a single global compared with ==, which made the whole capture
// feature single-adapter. Two receivers now run at once, so at most one of
// them could ever be captured from; and since capture.wifi_interface ships
// "wlan1" while deploy/udev/70-classg-wifi.rules renames the adapters to
// wlan-alfa and wlan-tplink, a default install could capture from neither.
//
// The configured value stays in the set even when no sensor reports it: a
// capture on an adapter whose sensor is down is exactly how an operator
// diagnoses the adapter.
func (s *Server) captureIfaces(ctx context.Context) []string {
	out := []string{}
	if s.cfg.WifiInterface != "" {
		out = append(out, s.cfg.WifiInterface)
	}
	for _, sensor := range s.Health(ctx).Sensors {
		if sensor.SensorKind != "wifi" {
			continue
		}
		if iface, ok := sensor.Detail["iface"].(string); ok && iface != "" && !slices.Contains(out, iface) {
			out = append(out, iface)
		}
	}
	return out
}

func (s *Server) handleStartCapture(w http.ResponseWriter, r *http.Request) {
	var req capture.Request
	if err := decodeBody(r, &req); err != nil {
		fail(w, err)
		return
	}
	if allowed := s.captureIfaces(r.Context()); !slices.Contains(allowed, req.Iface) {
		fail(w, apierr.InvalidParameter(
			"iface",
			fmt.Sprintf("iface must be one of %s (CLASSG_WIFI_INTERFACE, or an interface a Wi-Fi sensor is reading)",
				strings.Join(allowed, ", ")),
		))
		return
	}
	c, err := s.captures.Start(r.Context(), req)
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, c)
	case isValidation(err):
		var ve *capture.ValidationError
		errors.As(err, &ve)
		fail(w, apierr.InvalidParameter(ve.Field, ve.Message))
	case errors.Is(err, capture.ErrPrivileges):
		fail(w, apierr.PrivilegesRequired(err.Error()))
	case errors.Is(err, capture.ErrBusy):
		// 409, not 503: nothing is broken. The radio is doing its other job.
		fail(w, apierr.Conflict(err.Error()))
	case errors.Is(err, capture.ErrNotMonitor):
		fail(w, apierr.Conflict(err.Error()))
	default:
		fail(w, apierr.Internal("starting capture failed: "+err.Error()))
	}
}

func isValidation(err error) bool {
	var ve *capture.ValidationError
	return errors.As(err, &ve)
}

func (s *Server) handleStopCapture(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("capture_id")
	c, err := s.captures.Stop(r.Context(), id)
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, c)
	case errors.Is(err, store.ErrNotFound):
		fail(w, apierr.NotFound("no capture with id "+id))
	default:
		fail(w, apierr.Conflict(err.Error()))
	}
}

func (s *Server) handleAnalyzeCapture(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("capture_id")
	report, _, err := s.captures.Analyze(r.Context(), id)
	switch {
	case err == nil:
		writeJSONRaw(w, http.StatusOK, report)
	case errors.Is(err, store.ErrNotFound):
		fail(w, apierr.NotFound("no capture with id "+id))
	case errors.Is(err, capture.ErrAnalyzing):
		// 409, not 503: nothing is broken and the answer is to wait.
		fail(w, apierr.Conflict(err.Error()))
	case errors.Is(err, capture.ErrAnalyzerUnavailable):
		// The Wi-Fi sensor's Python environment is a separate deployment
		// artefact (ADR-0001); its absence is a machine problem, and
		// sensor_unavailable is the code the contract provides for that.
		fail(w, apierr.SensorUnavailable(err.Error()))
	default:
		fail(w, apierr.Conflict(err.Error()))
	}
}

func (s *Server) handleCaptureReport(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("capture_id")
	report, err := s.store.GetCaptureReport(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("capture "+id+" has no analysis; POST /captures/"+id+"/analyze first"))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("loading capture report failed"))
		return
	}
	writeJSONRaw(w, http.StatusOK, report)
}

// handleCaptureDownload streams the PCAP.
//
// http.ServeContent rather than io.Copy: it handles Range requests, so a
// half-finished download of a long capture resumes instead of restarting, and
// it never holds more than a buffer in memory.
func (s *Server) handleCaptureDownload(w http.ResponseWriter, r *http.Request) {
	c, err := s.captureOr404(w, r)
	if err != nil {
		return
	}
	path, err := s.captures.Path(c)
	if err != nil {
		fail(w, apierr.Internal("resolving capture path failed"))
		return
	}
	f, err := os.Open(path)
	if err != nil {
		fail(w, apierr.NotFound("capture file "+c.Filename+" is not on disk"))
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		fail(w, apierr.Internal("reading capture file failed"))
		return
	}

	w.Header().Set("Content-Type", "application/vnd.tcpdump.pcap")
	w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(c.Filename))
	http.ServeContent(w, r, c.Filename, fi.ModTime(), f)
}

func (s *Server) captureOr404(w http.ResponseWriter, r *http.Request) (model.Capture, error) {
	id := r.PathValue("capture_id")
	c, err := s.store.GetCapture(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no capture with id "+id))
		return model.Capture{}, err
	}
	if err != nil {
		fail(w, apierr.Internal("loading capture failed"))
		return model.Capture{}, err
	}
	return c, nil
}

// writeJSONRaw forwards already-encoded JSON without a re-marshal round trip.
func writeJSONRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

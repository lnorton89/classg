// Package httpapi implements docs/architecture/api-contract.md.
//
// Routing is net/http's ServeMux with Go 1.22 method-and-wildcard patterns.
// There is no router dependency because there is nothing here a router would
// do for us: no middleware stack, no route groups, no path rewriting.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/settings"
	"github.com/classg/api/internal/store"
)

// BasePath is the contract's base URL path.
const BasePath = "/api/v1"

// Sensors is the subset of the sensor manager the HTTP layer needs. An
// interface so that restart, which shells out to systemctl, can be faked.
type Sensors interface {
	Restart(sensorID, sensorKind string) error
}

type Server struct {
	cfg      *config.Config
	store    store.Store
	registry *health.Registry
	hub      *hub.Hub
	captures *capture.Manager
	sensors  Sensors
	started  time.Time
	settings *settings.Settings

	mux http.Handler
}

type Options struct {
	Config   *config.Config
	Settings *settings.Settings
	Store    store.Store
	Registry *health.Registry
	Hub      *hub.Hub
	Captures *capture.Manager
	Sensors  Sensors
	Started  time.Time
}

func New(opts Options) *Server {
	s := &Server{
		cfg:      opts.Config,
		settings: opts.Settings,
		store:    opts.Store,
		registry: opts.Registry,
		hub:      opts.Hub,
		captures: opts.Captures,
		sensors:  opts.Sensors,
		started:  opts.Started,
	}
	if s.started.IsZero() {
		s.started = time.Now()
	}
	s.mux = s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	h := func(pattern string, fn http.HandlerFunc) { mux.HandleFunc(pattern, fn) }

	h("GET "+BasePath+"/health", s.handleHealth)

	h("GET "+BasePath+"/tracks", s.handleListTracks)
	h("GET "+BasePath+"/tracks/{track_id}", s.handleGetTrack)
	h("GET "+BasePath+"/tracks/{track_id}/detections", s.handleTrackDetections)

	h("GET "+BasePath+"/detections", s.handleListDetections)

	h("GET "+BasePath+"/stream", s.handleStream)

	h("GET "+BasePath+"/captures", s.handleListCaptures)
	h("POST "+BasePath+"/captures", s.handleStartCapture)
	h("GET "+BasePath+"/captures/{capture_id}", s.handleGetCapture)
	h("POST "+BasePath+"/captures/{capture_id}/stop", s.handleStopCapture)
	h("POST "+BasePath+"/captures/{capture_id}/analyze", s.handleAnalyzeCapture)
	h("GET "+BasePath+"/captures/{capture_id}/report", s.handleCaptureReport)
	h("GET "+BasePath+"/captures/{capture_id}/download", s.handleCaptureDownload)

	h("GET "+BasePath+"/sensors", s.handleListSensors)
	h("POST "+BasePath+"/sensors/{sensor_id}/restart", s.handleRestartSensor)

	h("GET "+BasePath+"/config/channels", s.handleGetChannels)
	h("PUT "+BasePath+"/config/channels", s.handlePutChannels)
	h("GET "+BasePath+"/config/settings", s.handleGetSettings)
	h("PUT "+BasePath+"/config/settings", s.handlePutSettings)
	h("GET "+BasePath+"/config/weights", s.handleGetWeights)
	h("PUT "+BasePath+"/config/weights", s.handlePutWeights)

	// Anything else under /api gets the error envelope rather than ServeMux's
	// plain-text 404. A client that parses one shape must never be handed two.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		apierr.Write(w, apierr.NotFound("no such endpoint: "+r.Method+" "+r.URL.Path))
	})

	// Everything outside /api is the web app, if it was built.
	mux.Handle("/", s.staticHandler())

	return mux
}

// --- response helpers ------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The status line is already sent; all that is left is a log.
		slog.Error("writing response failed", "err", err)
	}
}

// fail maps a store or subsystem error onto the contract envelope.
func fail(w http.ResponseWriter, err error) {
	apierr.Write(w, err)
}

// --- query parsing ---------------------------------------------------------

// csvParam splits a comma-separated filter and validates it against a closed
// set. Rejecting an unknown value rather than ignoring it matters: silently
// returning zero rows for ?state=CONFIRMD looks identical to a quiet sky.
func csvParam(r *http.Request, name string, allowed map[string]bool) ([]string, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	var out []string
	for _, v := range strings.Split(raw, ",") {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if allowed != nil && !allowed[v] {
			return nil, apierr.InvalidParameter(name, name+": unknown value "+strconv.Quote(v))
		}
		out = append(out, v)
	}
	return out, nil
}

func timeParam(r *http.Request, name string) (time.Time, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, apierr.InvalidParameter(name, name+" must be an RFC3339 timestamp")
	}
	return t.UTC(), nil
}

func floatParam(r *http.Request, name string, min, max float64) (float64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, apierr.InvalidParameter(name, name+" must be a number")
	}
	if v < min || v > max {
		return 0, apierr.InvalidParameter(name,
			name+" must be between "+strconv.FormatFloat(min, 'g', -1, 64)+
				" and "+strconv.FormatFloat(max, 'g', -1, 64))
	}
	return v, nil
}

func limitParam(r *http.Request) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return store.DefaultLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, apierr.InvalidParameter("limit", "limit must be an integer")
	}
	limit, err := store.NormaliseLimit(n, true)
	if err != nil {
		return 0, apierr.InvalidParameter("limit", err.Error())
	}
	return limit, nil
}

func cursorParam(r *http.Request) (*store.Cursor, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("cursor"))
	if raw == "" {
		return nil, nil
	}
	c, err := store.DecodeCursor(raw)
	if err != nil {
		return nil, apierr.InvalidParameter("cursor", "cursor is not a cursor returned by this API")
	}
	return &c, nil
}

// decodeBody reads a JSON request body, rejecting unknown fields so that a
// client typo becomes a 400 instead of a silently ignored setting.
func decodeBody(r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return apierr.InvalidParameter("", "request body is not valid JSON for this endpoint: "+err.Error())
	}
	return nil
}

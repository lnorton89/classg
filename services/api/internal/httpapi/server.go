// Package httpapi implements docs/architecture/api-contract.md.
//
// Routing is net/http's ServeMux with Go 1.22 method-and-wildcard patterns.
// There is no router dependency because there is nothing here a router would
// do for us: no middleware stack, no route groups, no path rewriting.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/capture"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/deploy"
	"github.com/classg/api/internal/graphqlapi"
	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/hooks"
	"github.com/classg/api/internal/hub"
	"github.com/classg/api/internal/monitoring"
	"github.com/classg/api/internal/oidcauth"
	"github.com/classg/api/internal/settings"
	"github.com/classg/api/internal/spectrum"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/system"
)

// BasePath is the contract's base URL path.
const BasePath = "/api/v1"

// Sensors is the subset of the sensor manager the HTTP layer needs. An
// interface so that restart, which shells out to systemctl, can be faked.
type Sensors interface {
	Restart(sensorID, sensorKind string) error
}

type Server struct {
	cfg        *config.Config
	store      store.Store
	registry   *health.Registry
	hub        *hub.Hub
	captures   *capture.Manager
	spectrum   *spectrum.Service
	auth       *auth.Service
	localAgent *auth.LocalAgent
	oidc       *oidcauth.Provider
	hooks      *hooks.Dispatcher
	deploy     deploy.Reader
	sensors    Sensors
	started    time.Time
	settings   *settings.Settings
	monitoring *monitoring.Switch

	mux http.Handler
}

type Options struct {
	Config     *config.Config
	Settings   *settings.Settings
	Monitoring *monitoring.Switch
	Store      store.Store
	Registry   *health.Registry
	Hub        *hub.Hub
	Captures   *capture.Manager
	// Spectrum may be nil: a unit with no SDR still serves everything else,
	// and the band picker reports why rather than the page failing (ADR-0003).
	Spectrum *spectrum.Service
	// Auth may be nil only in tests that predate authentication; New builds a
	// disabled service rather than leaving a nil to dereference.
	Auth *auth.Service
	// OIDC is nil when SSO is not configured, which is the common case.
	OIDC *oidcauth.Provider
	// LocalAgent authenticates a process on this unit's own host as a viewer.
	// Nil is the same as one that was never minted: nobody authenticates that
	// way and everything else is unchanged.
	LocalAgent *auth.LocalAgent
	// Hooks may be nil; the endpoints then report the dispatcher as not
	// running rather than panicking.
	Hooks *hooks.Dispatcher
	// Deploy reads the host-side deploy agent's state. Zero value means this
	// unit has no agent, which is reported rather than hidden.
	Deploy  deploy.Reader
	Sensors Sensors
	// Started must come from time.Now() and keep its monotonic reading. Passing
	// a value that has been through .UTC(), .Round(0) or a parse makes uptime
	// wall-clock arithmetic again, which on an RTC-less Pi reports the boot-time
	// NTP correction as hours of uptime. See Health.
	Started time.Time
}

func New(opts Options) *Server {
	s := &Server{
		cfg:        opts.Config,
		settings:   opts.Settings,
		monitoring: opts.Monitoring,
		store:      opts.Store,
		registry:   opts.Registry,
		hub:        opts.Hub,
		captures:   opts.Captures,
		spectrum:   opts.Spectrum,
		auth:       opts.Auth,
		localAgent: opts.LocalAgent,
		oidc:       opts.OIDC,
		hooks:      opts.Hooks,
		deploy:     opts.Deploy,
		sensors:    opts.Sensors,
		started:    opts.Started,
	}
	if s.started.IsZero() {
		s.started = time.Now()
	}
	if s.auth == nil {
		// A nil service would panic on the first request. An explicitly
		// disabled one degrades the way ADR-0003 asks for: the API works, and
		// /auth/me reports auth_enabled false so the UI says so.
		s.auth = &auth.Service{Mode: auth.ModeOff}
	}
	if s.localAgent == nil {
		// Methods on LocalAgent tolerate a nil receiver, but an explicit zero
		// value keeps "no local agent" a state rather than an absence.
		s.localAgent = &auth.LocalAgent{}
	}
	s.mux = s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// now is wall-clock, for stamping records. Distinct from s.started, which keeps
// its monotonic reading because uptime is an interval -- see Health.
func (s *Server) now() time.Time { return time.Now().UTC() }

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// `open` is public; `view`, `act` and `admin` require a role. There is
	// deliberately no bare registration helper: adding a route means choosing
	// one of these four, and the three restrictive ones are the easy ones to
	// reach for. The public set below is short enough to audit at a glance.
	open := func(pattern string, fn http.HandlerFunc) { mux.HandleFunc(pattern, fn) }
	view := func(pattern string, fn http.HandlerFunc) {
		mux.HandleFunc(pattern, s.protect(auth.RoleViewer, fn))
	}
	act := func(pattern string, fn http.HandlerFunc) {
		mux.HandleFunc(pattern, s.protect(auth.RoleOperator, fn))
	}
	admin := func(pattern string, fn http.HandlerFunc) {
		mux.HandleFunc(pattern, s.protect(auth.RoleAdmin, fn))
	}

	// --- public ---
	//
	// health is open because a monitoring probe has no session and a unit that
	// only reports its health to authenticated callers cannot be monitored by
	// the thing that notices it died. It carries no detections and no
	// positions -- see handleHealth.
	open("GET "+BasePath+"/health", s.handleHealth)

	// The login surface. All of it must work for someone with no session.
	open("GET "+BasePath+"/auth/me", s.handleMe)
	open("POST "+BasePath+"/auth/login", s.handleLogin)
	open("POST "+BasePath+"/auth/logout", s.handleLogout)
	open("POST "+BasePath+"/auth/setup", s.handleSetup)
	open("GET "+BasePath+"/auth/sso/start", s.handleOIDCStart)
	open("GET "+BasePath+"/auth/sso/callback", s.handleOIDCCallback)

	view("POST "+BasePath+"/auth/password", s.handleChangePassword)

	// Not under /api/v1: every scraper in existence defaults to /metrics, and
	// the contract's error envelope has no meaning to one. A more specific
	// pattern than "/" wins in ServeMux, so this takes precedence over the web
	// app without the static handler needing to know.
	//
	// Left open for the same reason as health: Prometheus does not hold a
	// session cookie, and a scrape target that 401s is a scrape target nobody
	// is watching. It exposes counters and gauges, never positions or
	// identities -- internal/sensormetrics is the allowlist that keeps it that
	// way.
	open("GET /metrics", s.handleMetrics)

	// GraphQL: one endpoint, viewer-level, read-only. It answers "these tracks
	// and, for each, the detections that fed it" in one round trip -- over
	// REST that is a call per track on a link that is often a phone tethered
	// to this unit's own access point. Writes and the whole admin surface stay
	// on REST; see internal/graphqlapi for why that is a decision rather than
	// an unfinished half.
	//
	// A schema that fails to build is a programming error, not a runtime
	// condition, so it is reported and the endpoint is left absent rather than
	// serving a broken one. Everything else on this unit still works.
	if h, err := s.graphqlHandler(); err != nil {
		slog.Error("the GraphQL schema did not build; that endpoint is not served", "err", err)
	} else {
		view("POST "+BasePath+"/graphql", h)
	}

	view("GET "+BasePath+"/tracks", s.handleListTracks)
	view("GET "+BasePath+"/tracks/{track_id}", s.handleGetTrack)
	view("GET "+BasePath+"/tracks/{track_id}/detections", s.handleTrackDetections)
	view("GET "+BasePath+"/tracks/{track_id}/export", s.handleExportTrack)

	view("GET "+BasePath+"/detections", s.handleListDetections)

	view("GET "+BasePath+"/stream", s.handleStream)

	view("GET "+BasePath+"/captures", s.handleListCaptures)
	act("POST "+BasePath+"/captures", s.handleStartCapture)
	view("GET "+BasePath+"/captures/{capture_id}", s.handleGetCapture)
	act("POST "+BasePath+"/captures/{capture_id}/stop", s.handleStopCapture)
	act("POST "+BasePath+"/captures/{capture_id}/analyze", s.handleAnalyzeCapture)
	view("GET "+BasePath+"/captures/{capture_id}/report", s.handleCaptureReport)
	view("GET "+BasePath+"/captures/{capture_id}/download", s.handleCaptureDownload)

	// Energy measurement only -- see internal/spectrum. Sweeping takes the
	// radio from dump1090 for its duration (ADR-0008), which is why there is a
	// start endpoint and not a live stream.
	view("GET "+BasePath+"/spectrum/bands", s.handleListBands)
	view("GET "+BasePath+"/spectrum/sweeps", s.handleListSweeps)
	act("POST "+BasePath+"/spectrum/sweeps", s.handleStartSweep)
	view("GET "+BasePath+"/spectrum/sweeps/{sweep_id}", s.handleGetSweep)

	view("GET "+BasePath+"/system", s.handleSystem)
	view("GET "+BasePath+"/telemetry", s.handleTelemetry)

	view("GET "+BasePath+"/sensors", s.handleListSensors)
	act("POST "+BasePath+"/sensors/{sensor_id}/restart", s.handleRestartSensor)

	view("GET "+BasePath+"/config/channels", s.handleGetChannels)
	act("PUT "+BasePath+"/config/channels", s.handlePutChannels)
	view("GET "+BasePath+"/monitoring", s.handleGetMonitoring)
	act("PUT "+BasePath+"/monitoring", s.handlePutMonitoring)
	view("GET "+BasePath+"/config/settings", s.handleGetSettings)
	// Admin, not operator: this can repoint the store, the bus and the
	// capture directory. It is configuration of the machine, not operation
	// of it.
	admin("PUT "+BasePath+"/config/settings", s.handlePutSettings)
	view("GET "+BasePath+"/config/weights", s.handleGetWeights)
	act("PUT "+BasePath+"/config/weights", s.handlePutWeights)

	// --- administration ---
	admin("GET "+BasePath+"/admin/users", s.handleListUsers)
	admin("POST "+BasePath+"/admin/users", s.handleCreateUser)
	admin("PATCH "+BasePath+"/admin/users/{user_id}", s.handleUpdateUser)
	admin("DELETE "+BasePath+"/admin/users/{user_id}", s.handleDeleteUser)
	// Hooks are admin, not operator: a hook is an egress path that can send
	// what this box sees to an arbitrary URL or mailbox, so configuring one is
	// administration of the machine rather than operation of it.
	admin("GET "+BasePath+"/admin/hooks", s.handleListHookRules)
	admin("POST "+BasePath+"/admin/hooks", s.handleCreateHookRule)
	admin("PUT "+BasePath+"/admin/hooks/{rule_id}", s.handleUpdateHookRule)
	admin("DELETE "+BasePath+"/admin/hooks/{rule_id}", s.handleDeleteHookRule)
	admin("POST "+BasePath+"/admin/hooks/{rule_id}/test", s.handleTestHookRule)
	admin("GET "+BasePath+"/admin/hook-deliveries", s.handleListHookDeliveries)

	// Deployment. Read is admin rather than viewer: the log can name branches,
	// commit subjects and failure reasons, which is more about the operator's
	// infrastructure than about the airspace.
	admin("GET "+BasePath+"/admin/deployment", s.handleDeploymentStatus)
	admin("GET "+BasePath+"/admin/deployment/history", s.handleDeploymentHistory)
	admin("POST "+BasePath+"/admin/deployment/deploy", s.handleRequestDeploy)
	admin("DELETE "+BasePath+"/admin/deployment/deploy", s.handleCancelDeploy)
	admin("GET "+BasePath+"/admin/watchdog", s.handleWatchdogStatus)

	admin("GET "+BasePath+"/admin/sessions", s.handleListSessions)
	admin("DELETE "+BasePath+"/admin/sessions/{session_id}", s.handleRevokeSession)

	// Anything else under /api gets the error envelope rather than ServeMux's
	// plain-text 404. A client that parses one shape must never be handed two.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		apierr.Write(w, apierr.NotFound("no such endpoint: "+r.Method+" "+r.URL.Path))
	})

	// Everything outside /api is the web app, if it was built.
	mux.Handle("/", s.staticHandler())

	return mux
}

// graphqlHandler wires the query layer to the same subsystems the REST
// handlers use. Health and System are passed as closures because both need
// request-time inputs this server holds -- uptime with its monotonic reading,
// and the filesystem detections actually land on.
func (s *Server) graphqlHandler() (http.HandlerFunc, error) {
	return graphqlapi.Handler(graphqlapi.Deps{
		Store: s.store,
		// The same switch every REST read path honours. A second read path
		// that ignored it would be a privacy regression no REST test catches.
		ExposeOperatorLocation: s.cfg.ExposeOperatorLocation,
		Health: func(ctx context.Context) (health.Report, error) {
			return s.Health(ctx), nil
		},
		System: func(context.Context) (system.Info, error) {
			return system.Collect(system.Options{
				Version:    s.cfg.Version,
				Listen:     s.cfg.Listen,
				Store:      s.cfg.Store,
				UIDir:      s.cfg.UIDir,
				CaptureDir: s.cfg.CaptureDir,
				TursoURL:   s.cfg.TursoURL,
				DiskPath:   diskPath(s.cfg.DBPath, s.cfg.CaptureDir),
			}), nil
		},
		Spectrum: s.spectrum,
	})
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

package graphqlapi

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/graphql-go/graphql"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/spectrum"
	"github.com/classg/api/internal/store"
)

type resolvers struct{ deps Deps }

// The object types are package-level vars, which makes them shared by every
// schema this process builds -- two Servers in one test binary, for instance.
// Every field on them is stateless except Track.detections, which needs a
// store. Rather than baking one Server's deps into a shared type at build
// time, that resolver reads them from the request context, so a query always
// uses the deps of the schema it was executed against.
type ctxKey struct{}

func withResolvers(ctx context.Context, r *resolvers) context.Context {
	return context.WithValue(ctx, ctxKey{}, r)
}

func fromContext(ctx context.Context) *resolvers {
	r, _ := ctx.Value(ctxKey{}).(*resolvers)
	return r
}

// Redaction happens HERE, in the three places rows leave the store, and not in
// the type definitions.
//
// The operator's ground position is personal data under GDPR and leaves the
// unit only through an explicit allowlist (docs/research/06-legal-and-ethics).
// Putting the check in a resolver for the `operator` field would mean the next
// person to add a type carrying a position has to remember to add it again.
// Putting it at the store boundary means a track that reaches a resolver has
// already had it stripped, whatever field asks for it.
func (r *resolvers) redactTrack(t model.Track) model.Track {
	return t.Redact(r.deps.ExposeOperatorLocation)
}

func (r *resolvers) redactTracks(ts []model.Track) []model.Track {
	return model.RedactTracks(ts, r.deps.ExposeOperatorLocation)
}

func (r *resolvers) redactDetections(ds []model.Detection) []model.Detection {
	return model.RedactDetections(ds, r.deps.ExposeOperatorLocation)
}

func (r *resolvers) health(p graphql.ResolveParams) (any, error) {
	if r.deps.Health == nil {
		return nil, errors.New("health is not wired on this unit")
	}
	return r.deps.Health(ctxOrBackground(p))
}

func (r *resolvers) system(p graphql.ResolveParams) (any, error) {
	if r.deps.System == nil {
		return nil, errors.New("system information is not wired on this unit")
	}
	return r.deps.System(ctxOrBackground(p))
}

func (r *resolvers) sensors(p graphql.ResolveParams) (any, error) {
	list, err := r.deps.Store.ListSensors(ctxOrBackground(p))
	if err != nil {
		return nil, fmt.Errorf("listing sensors failed: %w", err)
	}
	if list == nil {
		return []store.SensorRecord{}, nil
	}
	return list, nil
}

func (r *resolvers) tracks(p graphql.ResolveParams) (any, error) {
	q := store.TrackQuery{}

	if raw, ok := p.Args["states"].([]any); ok {
		for _, v := range raw {
			s, _ := v.(string)
			// Rejected rather than ignored: silently returning zero rows for
			// state=CONFIRMD looks exactly like a quiet sky.
			if !model.TrackStates[s] {
				return nil, fmt.Errorf("states: unknown value %q", s)
			}
			q.States = append(q.States, s)
		}
	}
	since, err := timeArg(p.Args, "since")
	if err != nil {
		return nil, fmt.Errorf("since: %w", err)
	}
	q.Since = since
	if v, ok := p.Args["min_confidence"].(float64); ok {
		if v < 0 || v > 1 {
			return nil, errors.New("min_confidence must be between 0 and 1")
		}
		q.MinConfidence = v
	}
	if q.Limit, err = limitArg(p.Args, store.DefaultLimit); err != nil {
		return nil, err
	}
	if raw, ok := p.Args["cursor"].(string); ok && raw != "" {
		c, cerr := store.DecodeCursor(raw)
		if cerr != nil {
			return nil, errors.New("cursor: malformed")
		}
		q.Cursor = &c
	}

	page, err := r.deps.Store.ListTracks(ctxOrBackground(p), q)
	if err != nil {
		return nil, fmt.Errorf("listing tracks failed: %w", err)
	}
	page.Tracks = r.redactTracks(page.Tracks)
	return page, nil
}

func (r *resolvers) track(p graphql.ResolveParams) (any, error) {
	id, _ := p.Args["track_id"].(string)
	t, err := r.deps.Store.GetTrack(ctxOrBackground(p), id)
	if errors.Is(err, store.ErrNotFound) {
		// Null rather than an error. "There is no track with that id" is an
		// answer, and a GraphQL errors array would make a client that asked
		// for several tracks at once treat a miss as a failed query.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading the track failed: %w", err)
	}
	return r.redactTrack(t), nil
}

// trackDetections is the reason this endpoint exists: over REST it is one call
// per track, and the whole point of asking for tracks and their detections in
// one query is not paying for that walk.
//
// It is still a reconstruction, not a recorded fact. Nothing on the bus carries
// the association between a track and the detections that fed it, so this
// matches on the track's identity within its lifetime -- the same query
// GET /tracks/{id}/detections runs, with the same caveat.
func trackDetections(p graphql.ResolveParams) (any, error) {
	t, ok := p.Source.(model.Track)
	if !ok {
		return nil, nil
	}
	r := fromContext(ctxOrBackground(p))
	if r == nil {
		return nil, errors.New("no store is bound to this query")
	}
	limit, err := limitArg(p.Args, store.DefaultLimit)
	if err != nil {
		return nil, err
	}
	q := store.TrackDetectionQuery{
		Serial: t.Identity.Serial,
		MACs:   t.Identity.MACs,
		From:   t.FirstSeen,
		To:     t.LastSeen,
		Limit:  limit,
	}
	if raw, ok := p.Args["cursor"].(string); ok && raw != "" {
		c, cerr := store.DecodeCursor(raw)
		if cerr != nil {
			return nil, errors.New("cursor: malformed")
		}
		q.Cursor = &c
	}
	page, err := r.deps.Store.ListTrackDetections(ctxOrBackground(p), q)
	if err != nil {
		return nil, fmt.Errorf("listing the track's detections failed: %w", err)
	}
	page.Detections = r.redactDetections(page.Detections)
	return page, nil
}

func (r *resolvers) detections(p graphql.ResolveParams) (any, error) {
	q := store.DetectionQuery{}

	if raw, ok := p.Args["classes"].([]any); ok {
		for _, v := range raw {
			s, _ := v.(string)
			if !model.DetectionClasses[s] {
				return nil, fmt.Errorf("classes: unknown value %q", s)
			}
			q.Classes = append(q.Classes, s)
		}
	}
	if v, ok := p.Args["sensor_id"].(string); ok {
		q.SensorID = v
	}
	since, err := timeArg(p.Args, "since")
	if err != nil {
		return nil, fmt.Errorf("since: %w", err)
	}
	q.Since = since
	if q.Limit, err = limitArg(p.Args, store.DefaultLimit); err != nil {
		return nil, err
	}
	if raw, ok := p.Args["cursor"].(string); ok && raw != "" {
		c, cerr := store.DecodeCursor(raw)
		if cerr != nil {
			return nil, errors.New("cursor: malformed")
		}
		q.Cursor = &c
	}

	page, err := r.deps.Store.ListDetections(ctxOrBackground(p), q)
	if err != nil {
		return nil, fmt.Errorf("listing detections failed: %w", err)
	}
	page.Detections = r.redactDetections(page.Detections)
	return page, nil
}

func (r *resolvers) captures(p graphql.ResolveParams) (any, error) {
	list, err := r.deps.Store.ListCaptures(ctxOrBackground(p))
	if err != nil {
		return nil, fmt.Errorf("listing captures failed: %w", err)
	}
	if list == nil {
		return []model.Capture{}, nil
	}
	return list, nil
}

func (r *resolvers) capture(p graphql.ResolveParams) (any, error) {
	id, _ := p.Args["capture_id"].(string)
	c, err := r.deps.Store.GetCapture(ctxOrBackground(p), id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading the capture failed: %w", err)
	}
	return c, nil
}

// bandsResult mirrors the REST bands response, including its refusal to treat
// "this unit has no radio" as an error.
type bandsResult struct {
	Bands          []spectrum.Band `json:"bands"`
	Available      bool            `json:"available"`
	Reason         string          `json:"reason,omitempty"`
	RunningSweepID string          `json:"running_sweep_id,omitempty"`
}

func (r *resolvers) bands(p graphql.ResolveParams) (any, error) {
	out := bandsResult{Bands: []spectrum.Band{}}
	if r.deps.Spectrum == nil {
		out.Reason = "no sweep engine configured"
		return out, nil
	}
	out.RunningSweepID = r.deps.Spectrum.Running()
	bands, err := r.deps.Spectrum.Bands(ctxOrBackground(p))
	if err != nil {
		// Not an error result. ADR-0003: a missing sensor is a degraded state
		// with a reason, not a failed request.
		out.Reason = err.Error()
		return out, nil
	}
	out.Bands, out.Available = bands, true
	return out, nil
}

func (r *resolvers) sweeps(p graphql.ResolveParams) (any, error) {
	limit := 50
	if v, ok := p.Args["limit"].(int); ok {
		if v < 1 || v > 500 {
			return nil, errors.New("limit must be between 1 and 500")
		}
		limit = v
	}
	list, err := r.deps.Store.ListSweeps(ctxOrBackground(p), limit)
	if err != nil {
		return nil, fmt.Errorf("listing sweeps failed: %w", err)
	}
	if list == nil {
		return []model.SpectrumSweep{}, nil
	}
	return list, nil
}

// sweepSource carries the record plus the bins, so the trace and step_peaks
// resolvers below do not each go back to the store. The measurement is read
// once whether the query asks for one of them, both, or neither -- and neither
// is the common case, which is why the read is lazy rather than eager.
type sweepSource struct {
	model.SpectrumSweep
	bins []byte
	err  error
}

func (r *resolvers) sweep(p graphql.ResolveParams) (any, error) {
	id, _ := p.Args["sweep_id"].(string)
	ctx := ctxOrBackground(p)

	rec, err := r.deps.Store.GetSweep(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading the sweep failed: %w", err)
	}

	src := &sweepSource{SpectrumSweep: rec}
	bins, err := r.deps.Store.GetSweepBins(ctx, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		// Running, or failed. The record is the whole answer; an empty trace
		// would chart as a flat, quiet band that nobody measured.
	case err != nil:
		src.err = err
	default:
		src.bins = bins
	}
	return src, nil
}

func resolveTrace(p graphql.ResolveParams) (any, error) {
	src, ok := p.Source.(*sweepSource)
	if !ok || src.bins == nil {
		return nil, src.binsError()
	}
	doc, err := spectrum.ParseDoc(src.bins)
	if err != nil {
		return nil, fmt.Errorf("the stored measurement did not decode: %w", err)
	}
	width := spectrum.DefaultTraceWidth
	if v, ok := p.Args["bins"].(int); ok {
		if v < 1 || v > spectrum.MaxTraceWidth {
			return nil, fmt.Errorf("bins must be between 1 and %d", spectrum.MaxTraceWidth)
		}
		width = v
	}
	trace := spectrum.Stitch(doc, width)
	return trace, nil
}

func resolveStepPeaks(p graphql.ResolveParams) (any, error) {
	src, ok := p.Source.(*sweepSource)
	if !ok || src.bins == nil {
		return nil, src.binsError()
	}
	doc, err := spectrum.ParseDoc(src.bins)
	if err != nil {
		return nil, fmt.Errorf("the stored measurement did not decode: %w", err)
	}
	out := make([]stepPeak, 0, len(doc.Steps))
	for _, st := range doc.Steps {
		out = append(out, stepPeak{
			CenterHz: st.CenterHz,
			PeakHz:   st.PeakHz,
			PeakDBFS: st.PeakDBFS,
		})
	}
	return out, nil
}

type stepPeak struct {
	CenterHz int64    `json:"center_hz"`
	PeakHz   *float64 `json:"peak_hz"`
	PeakDBFS *float64 `json:"peak_dbfs"`
}

// binsError separates "there is no measurement" from "the measurement could
// not be read". The first is null; the second must not be, because a storage
// failure rendered as an empty chart is a lie.
func (s *sweepSource) binsError() error {
	if s == nil || s.err == nil {
		return nil
	}
	return fmt.Errorf("reading the measurement failed: %w", s.err)
}

// defaultTelemetryWindow matches the REST handler's, so the two answer the
// same question when neither is given a bound.
const defaultTelemetryWindow = 6 * time.Hour

func (r *resolvers) telemetry(p graphql.ResolveParams) (any, error) {
	q := store.TelemetryQuery{}
	var err error
	if q.Since, err = timeArg(p.Args, "since"); err != nil {
		return nil, fmt.Errorf("since: %w", err)
	}
	if q.Until, err = timeArg(p.Args, "until"); err != nil {
		return nil, fmt.Errorf("until: %w", err)
	}

	// Both bounds are INCLUSIVE and the store compares against them literally,
	// so an unset Until is the year 1 and filters out every sample ever
	// recorded. Sending zero values straight through made this query return an
	// empty list always, which reads exactly like a unit that has recorded no
	// telemetry. The REST handler has always defaulted these; this now does
	// too, to the same window.
	if q.Until.IsZero() {
		q.Until = time.Now().UTC()
	}
	if q.Since.IsZero() {
		q.Since = q.Until.Add(-defaultTelemetryWindow)
	}
	if q.Since.After(q.Until) {
		return nil, errors.New("since must be before until")
	}
	if q.Limit, err = limitArg(p.Args, store.DefaultLimit); err != nil {
		return nil, err
	}
	list, err := r.deps.Store.ListTelemetry(ctxOrBackground(p), q)
	if err != nil {
		return nil, fmt.Errorf("reading telemetry failed: %w", err)
	}
	if list == nil {
		return []store.TelemetrySample{}, nil
	}
	return list, nil
}

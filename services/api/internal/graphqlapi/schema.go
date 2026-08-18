// Package graphqlapi serves a read-only GraphQL view of the same data REST
// serves, at POST /api/v1/graphql.
//
// Why it exists, and what it deliberately does not do.
//
// The reason is one query: "the tracks from the last hour, and for each of
// them the detections that fed it". Over REST that is one list call plus one
// call per track, on a link that is often a phone tethered to the unit's own
// access point. GraphQL answers it in one round trip, and lets a client that
// only wants `track_id` and `last_seen` avoid pulling every position in each
// track's history.
//
// It is READ-ONLY, and that is a decision rather than an unfinished half. The
// write paths -- starting a capture, taking the radio for a sweep, creating a
// user, arming a hook -- each carry their own authorisation level and their own
// failure semantics (409 when the radio is busy, 503 when a sensor is gone).
// Restating those through a mutation resolver would mean two implementations
// of every rule, and the one people audit would be the REST one. So: REST
// writes, GraphQL reads, and the whole endpoint sits at a single viewer-level
// permission that is trivial to reason about.
//
// The admin surface -- users, sessions, hook rules and their secrets,
// deployment state -- is not exposed here AT ALL, for the same reason. Those
// endpoints are admin-only in REST; a viewer-level query language that could
// reach them would be a privilege escalation with extra steps. There is no
// resolver for them to find.
//
// Operator ground position goes through the same allowlist as every other read
// path. resolvers.go redacts once, at the point rows leave the store, so a
// field added to the schema later cannot route around it.
package graphqlapi

import (
	"context"

	"github.com/graphql-go/graphql"

	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/spectrum"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/system"
)

// Deps is everything the resolvers may touch. It is a short list on purpose:
// what is not here cannot be queried, and adding to it is the moment to ask
// whether a viewer should be able to read the thing at all.
type Deps struct {
	Store store.Store

	// ExposeOperatorLocation mirrors the config flag the REST handlers read.
	// GraphQL is a new way to reach the same rows, so it must honour the same
	// switch -- a second read path that ignores it would be a privacy
	// regression that no REST test could catch.
	ExposeOperatorLocation bool

	// Health and System are closures rather than the subsystems themselves,
	// because both need request-time inputs the httpapi server already holds
	// (uptime with its monotonic reading, the configured disk path).
	Health func(context.Context) (health.Report, error)
	System func(context.Context) (system.Info, error)

	// Spectrum is nil on a unit with no SDR. Sweeps already stored stay
	// readable; only the live band list needs the sensor.
	Spectrum *spectrum.Service
}

// Schema builds the executable schema. It is built once, at startup, so a
// malformed type definition fails the process rather than the first query.
func Schema(deps Deps) (graphql.Schema, error) {
	r := &resolvers{deps: deps}
	return graphql.NewSchema(graphql.SchemaConfig{Query: r.queryType()})
}

func (r *resolvers) queryType() *graphql.Object {
	return graphql.NewObject(graphql.ObjectConfig{
		Name:        "Query",
		Description: "Everything a viewer may read. Writes stay on REST -- see the package comment.",
		Fields: graphql.Fields{
			"health": &graphql.Field{
				Type:        graphql.NewNonNull(healthType),
				Description: "Unit and sensor health. The same document GET /health returns.",
				Resolve:     r.health,
			},
			"system": &graphql.Field{
				Type:        graphql.NewNonNull(systemType),
				Description: "Build, runtime and host facts. Unreadable host figures are null, never zero.",
				Resolve:     r.system,
			},
			"sensors": &graphql.Field{
				Type:        graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(sensorRecordType))),
				Description: "Last known state of every sensor that has ever reported.",
				Resolve:     r.sensors,
			},

			"tracks": &graphql.Field{
				Type:        graphql.NewNonNull(trackPageType),
				Description: "Fused tracks, newest first. Keyset paged; pass next_cursor back as cursor.",
				Args: graphql.FieldConfigArgument{
					"states":         &graphql.ArgumentConfig{Type: graphql.NewList(graphql.NewNonNull(graphql.String))},
					"since":          &graphql.ArgumentConfig{Type: graphql.String, Description: "RFC3339."},
					"min_confidence": &graphql.ArgumentConfig{Type: graphql.Float},
					"limit":          &graphql.ArgumentConfig{Type: graphql.Int},
					"cursor":         &graphql.ArgumentConfig{Type: graphql.String},
				},
				Resolve: r.tracks,
			},
			"track": &graphql.Field{
				Type:        trackType,
				Description: "One track, or null if there is no such id.",
				Args: graphql.FieldConfigArgument{
					"track_id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)},
				},
				Resolve: r.track,
			},

			"detections": &graphql.Field{
				Type:        graphql.NewNonNull(detectionPageType),
				Description: "Raw sensor observations, newest first.",
				Args: graphql.FieldConfigArgument{
					"classes":   &graphql.ArgumentConfig{Type: graphql.NewList(graphql.NewNonNull(graphql.String))},
					"sensor_id": &graphql.ArgumentConfig{Type: graphql.String},
					"since":     &graphql.ArgumentConfig{Type: graphql.String, Description: "RFC3339."},
					"limit":     &graphql.ArgumentConfig{Type: graphql.Int},
					"cursor":    &graphql.ArgumentConfig{Type: graphql.String},
				},
				Resolve: r.detections,
			},

			"captures": &graphql.Field{
				Type:        graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(captureType))),
				Description: "Recorded captures. Metadata only; the PCAP itself is a REST download.",
				Resolve:     r.captures,
			},
			"capture": &graphql.Field{
				Type: captureType,
				Args: graphql.FieldConfigArgument{
					"capture_id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)},
				},
				Resolve: r.capture,
			},

			"bands": &graphql.Field{
				Type:        graphql.NewNonNull(bandsType),
				Description: "The sweep plan this unit can run. available is false, with a reason, on a unit with no radio.",
				Resolve:     r.bands,
			},
			"sweeps": &graphql.Field{
				Type:        graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(sweepType))),
				Description: "Past sweeps, newest first. Energy measurements; nothing here identifies anything.",
				Args: graphql.FieldConfigArgument{
					"limit": &graphql.ArgumentConfig{Type: graphql.Int},
				},
				Resolve: r.sweeps,
			},
			"sweep": &graphql.Field{
				Type: sweepDetailType,
				Args: graphql.FieldConfigArgument{
					"sweep_id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.ID)},
				},
				Resolve: r.sweep,
			},

			"telemetry": &graphql.Field{
				Type:        graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(telemetrySampleType))),
				Description: "Host and sensor history, oldest first.",
				Args: graphql.FieldConfigArgument{
					"since": &graphql.ArgumentConfig{Type: graphql.String, Description: "RFC3339."},
					"until": &graphql.ArgumentConfig{Type: graphql.String, Description: "RFC3339."},
					"limit": &graphql.ArgumentConfig{Type: graphql.Int},
				},
				Resolve: r.telemetry,
			},
		},
	})
}

// limitArg applies the contract's paging bounds to an optional argument, so a
// GraphQL client cannot ask for a page REST would refuse.
func limitArg(args map[string]any, def int) (int, error) {
	v, ok := args["limit"].(int)
	if !ok {
		return def, nil
	}
	return store.NormaliseLimit(v, true)
}

func ctxOrBackground(p graphql.ResolveParams) context.Context {
	if p.Context != nil {
		return p.Context
	}
	return context.Background()
}

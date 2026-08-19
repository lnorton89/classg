package graphqlapi

import (
	"strconv"
	"time"

	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/language/ast"

	"github.com/classg/api/internal/model"
)

// Field names are the JSON names from docs/architecture/api-contract.md, not
// camelCase.
//
// GraphQL convention would say `trackId`; the contract says `track_id`, four
// services already speak it, and schemas/*.schema.json is the authority for
// all of them. A second spelling of every field would mean a client author
// translating between two names for one thing, and it would mean this schema
// could drift from the contract without anything noticing. Keeping the JSON
// names also lets graphql-go's default resolver read the existing structs
// through their json tags, so there is no hand-written resolver per field to
// fall out of date.
//
// Nothing here is non-null unless it is genuinely always present. A field that
// is absent because a sensor could not measure it must arrive as null, never
// as a zero -- the same rule the REST types follow with pointers.

var positionType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "Position",
	Description: "A position report for the aircraft.",
	Fields: graphql.Fields{
		"lat":                 &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"lon":                 &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"alt_geodetic_m":      &graphql.Field{Type: graphql.Float},
		"alt_pressure_m":      &graphql.Field{Type: graphql.Float},
		"height_agl_m":        &graphql.Field{Type: graphql.Float},
		"terrain_elevation_m": &graphql.Field{Type: graphql.Float},
		"speed_mps":           &graphql.Field{Type: graphql.Float},
		"track_deg":           &graphql.Field{Type: graphql.Float},
		"h_accuracy_m":        &graphql.Field{Type: graphql.Float},
		"v_accuracy_m":        &graphql.Field{Type: graphql.Float},
		"at":                  &graphql.Field{Type: graphql.DateTime},
	},
})

// operatorPositionType is the pilot's ground position, and it is a separate
// type from Position for the same reason the Go model separates them: "did
// this response carry the operator's location rather than the aircraft's" has
// to be answerable by looking at the type. Whether it is populated at all is
// decided in resolvers.go, once, for every path.
var operatorPositionType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "OperatorPosition",
	Description: "The pilot's ground position. Personal data; withheld unless the unit is configured to expose it.",
	Fields: graphql.Fields{
		"lat":   &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"lon":   &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"alt_m": &graphql.Field{Type: graphql.Float},
		"at":    &graphql.Field{Type: graphql.DateTime},
	},
})

var evidenceType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "Evidence",
	Description: "One sensor's contribution to a track's confidence.",
	Fields: graphql.Fields{
		"class":       &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"sensor_kind": &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"weight":      &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"count":       &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
		"last_seen":   &graphql.Field{Type: graphql.DateTime},
	},
})

var trackIdentityType = graphql.NewObject(graphql.ObjectConfig{
	Name: "TrackIdentity",
	Fields: graphql.Fields{
		"serial":            &graphql.Field{Type: graphql.String},
		"macs":              &graphql.Field{Type: graphql.NewList(graphql.NewNonNull(graphql.String))},
		"vendor":            &graphql.Field{Type: graphql.String},
		"manufacturer_code": &graphql.Field{Type: graphql.String},
		"model_hint":        &graphql.Field{Type: graphql.String},
		"operator_id":       &graphql.Field{Type: graphql.String},
		"ua_type":           &graphql.Field{Type: graphql.String},
	},
})

var rfType = graphql.NewObject(graphql.ObjectConfig{
	Name: "RF",
	Fields: graphql.Fields{
		"freq_hz":      &graphql.Field{Type: hzScalar},
		"channel":      &graphql.Field{Type: graphql.Int},
		"rssi_dbm":     &graphql.Field{Type: graphql.Float},
		"bandwidth_hz": &graphql.Field{Type: hzScalar},
		"snr_db":       &graphql.Field{Type: graphql.Float},
	},
})

var detectionIdentityType = graphql.NewObject(graphql.ObjectConfig{
	Name: "DetectionIdentity",
	Fields: graphql.Fields{
		"serial":      &graphql.Field{Type: graphql.String},
		"mac":         &graphql.Field{Type: graphql.String},
		"id_type":     &graphql.Field{Type: graphql.String},
		"ua_type":     &graphql.Field{Type: graphql.String},
		"operator_id": &graphql.Field{Type: graphql.String},
		"self_id":     &graphql.Field{Type: graphql.String},
		"vendor_hint": &graphql.Field{Type: graphql.String},
	},
})

var kinematicsType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Kinematics",
	Fields: graphql.Fields{
		"speed_mps":          &graphql.Field{Type: graphql.Float},
		"track_deg":          &graphql.Field{Type: graphql.Float},
		"vertical_speed_mps": &graphql.Field{Type: graphql.Float},
	},
})

var signalFeaturesType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "SignalFeatures",
	Description: "Waveform shape. Describes energy, never identity.",
	Fields: graphql.Fields{
		"burst_rate_hz":     &graphql.Field{Type: graphql.Float},
		"burst_duration_us": &graphql.Field{Type: graphql.Float},
		"duty_cycle":        &graphql.Field{Type: graphql.Float},
		"hop_count":         &graphql.Field{Type: graphql.Int},
		"occupied_bw_hz":    &graphql.Field{Type: hzScalar},
		"protocol_hint":     &graphql.Field{Type: graphql.String},
	},
})

var adsbType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "ADSB",
	Description: "Crewed-aircraft context from dump1090. Never a drone.",
	Fields: graphql.Fields{
		"icao":            &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"callsign":        &graphql.Field{Type: graphql.String},
		"alt_ft":          &graphql.Field{Type: graphql.Int},
		"ground_speed_kt": &graphql.Field{Type: graphql.Float},
	},
})

// detectionType and trackType are declared empty and filled in init, because
// Track.detections returns Detections and nothing else here can be defined
// before both names exist.
var (
	detectionType = graphql.NewObject(graphql.ObjectConfig{
		Name:        "Detection",
		Description: "One sensor observation, as published on the bus.",
		Fields:      graphql.Fields{},
	})
	trackType = graphql.NewObject(graphql.ObjectConfig{
		Name:        "Track",
		Description: "Fusion's view of one aircraft over time.",
		Fields:      graphql.Fields{},
	})
	detectionPageType = graphql.NewObject(graphql.ObjectConfig{
		Name:   "DetectionPage",
		Fields: graphql.Fields{},
	})
	trackPageType = graphql.NewObject(graphql.ObjectConfig{
		Name:   "TrackPage",
		Fields: graphql.Fields{},
	})
)

func init() {
	detectionType.AddFieldConfig("schema_version", &graphql.Field{Type: graphql.String})
	detectionType.AddFieldConfig("detection_id", &graphql.Field{Type: graphql.NewNonNull(graphql.ID)})
	// FlexTime is a struct wrapping time.Time, so the default resolver would
	// hand the DateTime scalar something it cannot serialise.
	detectionType.AddFieldConfig("ts", &graphql.Field{
		Type: graphql.NewNonNull(graphql.DateTime),
		Resolve: func(p graphql.ResolveParams) (any, error) {
			d, ok := p.Source.(model.Detection)
			if !ok {
				return nil, nil
			}
			return d.TS.Time, nil
		},
	})
	detectionType.AddFieldConfig("sensor_id", &graphql.Field{Type: graphql.NewNonNull(graphql.String)})
	detectionType.AddFieldConfig("sensor_kind", &graphql.Field{Type: graphql.NewNonNull(graphql.String)})
	detectionType.AddFieldConfig("detection_class", &graphql.Field{Type: graphql.NewNonNull(graphql.String)})
	detectionType.AddFieldConfig("rf", &graphql.Field{Type: rfType})
	detectionType.AddFieldConfig("identity", &graphql.Field{Type: detectionIdentityType})
	detectionType.AddFieldConfig("position", &graphql.Field{Type: positionType})
	detectionType.AddFieldConfig("kinematics", &graphql.Field{Type: kinematicsType})
	detectionType.AddFieldConfig("operator", &graphql.Field{Type: operatorPositionType})
	detectionType.AddFieldConfig("signal_features", &graphql.Field{Type: signalFeaturesType})
	detectionType.AddFieldConfig("adsb", &graphql.Field{Type: adsbType})
	// `raw` is deliberately absent. It is the vendor IE bytes, it exists so
	// parser fixes can be replayed over history, and a query language that
	// makes it one word away from every response is the wrong place for it.
	// GET /api/v1/detections still carries it.

	trackType.AddFieldConfig("schema_version", &graphql.Field{Type: graphql.String})
	trackType.AddFieldConfig("track_id", &graphql.Field{Type: graphql.NewNonNull(graphql.ID)})
	trackType.AddFieldConfig("state", &graphql.Field{Type: graphql.NewNonNull(graphql.String)})
	trackType.AddFieldConfig("first_seen", &graphql.Field{Type: graphql.NewNonNull(graphql.DateTime)})
	trackType.AddFieldConfig("last_seen", &graphql.Field{Type: graphql.NewNonNull(graphql.DateTime)})
	trackType.AddFieldConfig("detection_count", &graphql.Field{Type: graphql.NewNonNull(graphql.Int)})
	trackType.AddFieldConfig("identity", &graphql.Field{Type: trackIdentityType})
	trackType.AddFieldConfig("confidence", &graphql.Field{Type: graphql.NewNonNull(graphql.Float)})
	trackType.AddFieldConfig("evidence", &graphql.Field{Type: graphql.NewList(graphql.NewNonNull(evidenceType))})
	trackType.AddFieldConfig("current", &graphql.Field{Type: positionType})
	trackType.AddFieldConfig("history", &graphql.Field{Type: graphql.NewList(graphql.NewNonNull(positionType))})
	trackType.AddFieldConfig("operator", &graphql.Field{Type: operatorPositionType})
	trackType.AddFieldConfig("rssi_dbm", &graphql.Field{Type: graphql.Float})
	trackType.AddFieldConfig("adsb_correlated", &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)})
	// The whole reason this API exists alongside REST. Over REST, tracks plus
	// their detections is one list call and then one call per track, on a link
	// that is often a phone tethered to the unit's own access point.
	trackType.AddFieldConfig("detections", &graphql.Field{
		Type:        graphql.NewNonNull(detectionPageType),
		Description: "The detections that fed this track. A reconstruction from identity within the track's lifetime, not a recorded association -- nothing on the bus carries the link.",
		Args: graphql.FieldConfigArgument{
			"limit":  &graphql.ArgumentConfig{Type: graphql.Int},
			"cursor": &graphql.ArgumentConfig{Type: graphql.String},
		},
		Resolve: trackDetections,
	})

	detectionPageType.AddFieldConfig("detections", &graphql.Field{
		Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(detectionType))),
	})
	detectionPageType.AddFieldConfig("next_cursor", &graphql.Field{Type: graphql.String})
	detectionPageType.AddFieldConfig("total", &graphql.Field{Type: graphql.Int})

	trackPageType.AddFieldConfig("tracks", &graphql.Field{
		Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(trackType))),
	})
	trackPageType.AddFieldConfig("next_cursor", &graphql.Field{Type: graphql.String})
	trackPageType.AddFieldConfig("total", &graphql.Field{Type: graphql.Int})
}

// hzScalar carries frequencies, which pass 2^31 at 2.4 GHz and would silently
// truncate through GraphQL's 32-bit Int. Serialised as a string rather than a
// float so no digit is lost on the way through a JavaScript client either.
var hzScalar = graphql.NewScalar(graphql.ScalarConfig{
	Name:        "Hz",
	Description: "A frequency in hertz, as a decimal string. Too large for GraphQL's 32-bit Int.",
	Serialize: func(value any) any {
		switch v := value.(type) {
		case int64:
			return formatInt64(v)
		case *int64:
			if v == nil {
				return nil
			}
			return formatInt64(*v)
		case int:
			return formatInt64(int64(v))
		}
		return nil
	},
	ParseValue: func(value any) any {
		s, ok := value.(string)
		if !ok {
			return nil
		}
		return parseInt64(s)
	},
	ParseLiteral: func(valueAST ast.Value) any {
		switch v := valueAST.(type) {
		case *ast.StringValue:
			return parseInt64(v.Value)
		case *ast.IntValue:
			return parseInt64(v.Value)
		}
		return nil
	},
})

// timeArg is a helper for the several queries that take an RFC3339 bound.
func timeArg(args map[string]any, name string) (time.Time, error) {
	raw, ok := args[name].(string)
	if !ok || raw == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

func formatInt64(v int64) string { return strconv.FormatInt(v, 10) }

func parseInt64(s string) any {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return nil
	}
	return v
}

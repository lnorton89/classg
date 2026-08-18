package graphqlapi

import (
	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/language/ast"
)

// Health, system, sensors, captures and spectrum, as GraphQL types.
//
// Split from types.go, which holds the schemas/*.schema.json domain -- tracks
// and detections. These are this API's own reporting types, which are free to
// change without a cross-language contract negotiation.

var fusionLinkType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "FusionLink",
	Description: "Whether the fusion service is reachable on the bus.",
	Fields: graphql.Fields{
		"configured":   &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
		"connected":    &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
		"last_message": &graphql.Field{Type: graphql.DateTime},
		"reason":       &graphql.Field{Type: graphql.String},
	},
})

var healthSensorType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "HealthSensor",
	Description: "One sensor's live state.",
	Fields: graphql.Fields{
		"sensor_id":   &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"sensor_kind": &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"healthy":     &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
		// Null on a sensor that has never reported, which is a different fact
		// from one that reported a long time ago.
		"last_heartbeat":          &graphql.Field{Type: graphql.DateTime},
		"seconds_since_heartbeat": &graphql.Field{Type: graphql.Int},
		"detections_5m":           &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
		// Populated whenever healthy is false. A degraded sensor without a
		// reason sends an operator to the wrong place (ADR-0003).
		"reason":   &graphql.Field{Type: graphql.String},
		"optional": &graphql.Field{Type: graphql.Boolean},
		"detail":   &graphql.Field{Type: jsonScalar},
	},
})

var healthType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Health",
	Fields: graphql.Fields{
		"status":   &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"uptime_s": &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
		"version":  &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"sensors": &graphql.Field{
			Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(healthSensorType))),
		},
		"fusion": &graphql.Field{Type: graphql.NewNonNull(fusionLinkType)},
	},
})

// sensorRecordType is the stored last-known state, which outlives a restart.
// healthSensorType is the live view; the two differ and conflating them would
// make "healthy" mean two things.
var sensorRecordType = graphql.NewObject(graphql.ObjectConfig{
	Name: "SensorRecord",
	Fields: graphql.Fields{
		"sensor_id":      &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"sensor_kind":    &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"last_heartbeat": &graphql.Field{Type: graphql.DateTime},
		"healthy":        &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
		"reason":         &graphql.Field{Type: graphql.String},
		"detail":         &graphql.Field{Type: jsonScalar},
	},
})

var buildType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Build",
	Fields: graphql.Fields{
		"version":    &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"go_version": &graphql.Field{Type: graphql.String},
		// Empty in container builds: .dockerignore excludes .git, so the
		// toolchain has no VCS to stamp.
		"revision":       &graphql.Field{Type: graphql.String},
		"revision_dirty": &graphql.Field{Type: graphql.Boolean},
		"built_at":       &graphql.Field{Type: graphql.String},
	},
})

var runtimeType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "Runtime",
	Description: "Configuration worth showing an operator. Never a credential or a sync URL.",
	Fields: graphql.Fields{
		"listen":                &graphql.Field{Type: graphql.String},
		"store":                 &graphql.Field{Type: graphql.String},
		"ui_dir":                &graphql.Field{Type: graphql.String},
		"capture_dir":           &graphql.Field{Type: graphql.String},
		"turso_sync_configured": &graphql.Field{Type: graphql.Boolean},
		"containerised":         &graphql.Field{Type: graphql.Boolean},
	},
})

var hostType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "Host",
	Description: "The Pi underneath. Every figure is null when it could not be read -- a zero would plot a cold, idle, empty machine.",
	Fields: graphql.Fields{
		"uptime_s":         &graphql.Field{Type: graphql.Int},
		"load1":            &graphql.Field{Type: graphql.Float},
		"load5":            &graphql.Field{Type: graphql.Float},
		"load15":           &graphql.Field{Type: graphql.Float},
		"cpu_count":        &graphql.Field{Type: graphql.Int},
		"cpu_temp_c":       &graphql.Field{Type: graphql.Float},
		"mem_total_kb":     &graphql.Field{Type: graphql.Int},
		"mem_available_kb": &graphql.Field{Type: graphql.Int},
		"disk_path":        &graphql.Field{Type: graphql.String},
		// Bytes, which pass 2^31 on any real disk.
		"disk_total_bytes": &graphql.Field{Type: hzScalar},
		"disk_free_bytes":  &graphql.Field{Type: hzScalar},
		// Field name -> why it is unreadable, so a client can say "not
		// readable from a container" rather than drawing a blank.
		"unavailable": &graphql.Field{Type: jsonScalar},
	},
})

var systemType = graphql.NewObject(graphql.ObjectConfig{
	Name: "System",
	Fields: graphql.Fields{
		"build":   &graphql.Field{Type: graphql.NewNonNull(buildType)},
		"runtime": &graphql.Field{Type: graphql.NewNonNull(runtimeType)},
		"host":    &graphql.Field{Type: graphql.NewNonNull(hostType)},
	},
})

var captureAnalysisType = graphql.NewObject(graphql.ObjectConfig{
	Name: "CaptureAnalysis",
	Fields: graphql.Fields{
		"analyzed":           &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
		"drone_transmitters": &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
		"class_a":            &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
		"class_b":            &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
	},
})

var captureType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "Capture",
	Description: "A recorded PCAP. The file itself is a REST download, not a field.",
	Fields: graphql.Fields{
		"capture_id":  &graphql.Field{Type: graphql.NewNonNull(graphql.ID)},
		"filename":    &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"state":       &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"started_at":  &graphql.Field{Type: graphql.NewNonNull(graphql.DateTime)},
		"ended_at":    &graphql.Field{Type: graphql.DateTime},
		"iface":       &graphql.Field{Type: graphql.String},
		"channel":     &graphql.Field{Type: graphql.Int},
		"duration_s":  &graphql.Field{Type: graphql.Int},
		"size_bytes":  &graphql.Field{Type: hzScalar},
		"frame_count": &graphql.Field{Type: graphql.Int},
		"label":       &graphql.Field{Type: graphql.String},
		"error":       &graphql.Field{Type: graphql.String},
		"analysis":    &graphql.Field{Type: captureAnalysisType},
	},
})

var bandType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Band",
	Fields: graphql.Fields{
		"name":     &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"class":    &graphql.Field{Type: graphql.String},
		"note":     &graphql.Field{Type: graphql.String},
		"start_hz": &graphql.Field{Type: hzScalar},
		"stop_hz":  &graphql.Field{Type: hzScalar},
		"steps":    &graphql.Field{Type: graphql.Int},
	},
})

var bandsType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "Bands",
	Description: "The band plan, and whether this unit can actually sweep it.",
	Fields: graphql.Fields{
		"bands": &graphql.Field{
			Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(bandType))),
		},
		// False is not an error. A unit with no SDR is a working unit with one
		// fewer sensor, and reason says which so an operator is not sent
		// looking for a fault that is not there.
		"available": &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
		"reason":    &graphql.Field{Type: graphql.String},
		// Non-empty while the radio is taken.
		"running_sweep_id": &graphql.Field{Type: graphql.String},
	},
})

// Every dBFS field is nullable. A missing noise floor is not a floor of
// 0 dBFS -- that reads as a full-scale signal across the whole band, which is
// the most alarming possible way to render "we did not measure".
var sweepFields = graphql.Fields{
	"sweep_id":         &graphql.Field{Type: graphql.NewNonNull(graphql.ID)},
	"band":             &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
	"state":            &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
	"started_at":       &graphql.Field{Type: graphql.NewNonNull(graphql.DateTime)},
	"ended_at":         &graphql.Field{Type: graphql.DateTime},
	"class":            &graphql.Field{Type: graphql.String},
	"note":             &graphql.Field{Type: graphql.String},
	"start_hz":         &graphql.Field{Type: hzScalar},
	"stop_hz":          &graphql.Field{Type: hzScalar},
	"steps":            &graphql.Field{Type: graphql.Int},
	"noise_floor_dbfs": &graphql.Field{Type: graphql.Float},
	"threshold_dbfs":   &graphql.Field{Type: graphql.Float},
	"peak_dbfs":        &graphql.Field{Type: graphql.Float},
	"peak_hz":          &graphql.Field{Type: graphql.Float},
	"short_reads":      &graphql.Field{Type: graphql.Int},
	"error":            &graphql.Field{Type: graphql.String},
}

var sweepType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "Sweep",
	Description: "One band, measured once. ENERGY only -- a peak above threshold means something is transmitting, never that it is a drone.",
	Fields:      copyFields(sweepFields),
})

var traceType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Trace",
	Description: "The band as one line. A null cell is a frequency the receiver could not see -- " +
		"its own oscillator sits at each step centre -- and a client that joins across one draws a level nobody measured.",
	Fields: graphql.Fields{
		"start_hz":     &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"stop_hz":      &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"bin_width_hz": &graphql.Field{Type: graphql.NewNonNull(graphql.Float)},
		"dbfs":         &graphql.Field{Type: graphql.NewList(graphql.Float)},
		"blind":        &graphql.Field{Type: graphql.NewNonNull(graphql.Int)},
	},
})

var stepPeakType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "StepPeak",
	Description: "One tune step's own peak, which the stitched trace flattens away.",
	Fields: graphql.Fields{
		"center_hz": &graphql.Field{Type: hzScalar},
		"peak_hz":   &graphql.Field{Type: graphql.Float},
		"peak_dbfs": &graphql.Field{Type: graphql.Float},
	},
})

var sweepDetailType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "SweepDetail",
	Description: "A sweep with its measurement. trace and step_peaks are null while it runs and on one that failed.",
	Fields:      copyFields(sweepFields),
})

var telemetrySensorType = graphql.NewObject(graphql.ObjectConfig{
	Name: "TelemetrySensor",
	Fields: graphql.Fields{
		"sensor_id":   &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"sensor_kind": &graphql.Field{Type: graphql.NewNonNull(graphql.String)},
		"healthy":     &graphql.Field{Type: graphql.NewNonNull(graphql.Boolean)},
		"metrics":     &graphql.Field{Type: jsonScalar},
	},
})

var telemetrySampleType = graphql.NewObject(graphql.ObjectConfig{
	Name:        "TelemetrySample",
	Description: "One moment of host and sensor state. Unreadable figures are null, so a chart draws a gap rather than a cold Pi.",
	Fields: graphql.Fields{
		"ts":               &graphql.Field{Type: graphql.NewNonNull(graphql.DateTime)},
		"cpu_temp_c":       &graphql.Field{Type: graphql.Float},
		"load1":            &graphql.Field{Type: graphql.Float},
		"mem_available_kb": &graphql.Field{Type: hzScalar},
		"disk_free_bytes":  &graphql.Field{Type: hzScalar},
		"uptime_s":         &graphql.Field{Type: hzScalar},
		"sensors": &graphql.Field{
			Type: graphql.NewList(graphql.NewNonNull(telemetrySensorType)),
		},
	},
})

func init() {
	sweepDetailType.AddFieldConfig("trace", &graphql.Field{
		Type: traceType,
		Args: graphql.FieldConfigArgument{
			"bins": &graphql.ArgumentConfig{
				Type:        graphql.Int,
				Description: "Output cells. Past the measurement's own resolution the extra cells are interpolation pretending to be data, so this is capped.",
			},
		},
		Resolve: resolveTrace,
	})
	sweepDetailType.AddFieldConfig("step_peaks", &graphql.Field{
		Type:    graphql.NewList(graphql.NewNonNull(stepPeakType)),
		Resolve: resolveStepPeaks,
	})
}

func copyFields(in graphql.Fields) graphql.Fields {
	out := make(graphql.Fields, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// jsonScalar carries the handful of open-ended maps this API reports: a
// sensor's `detail`, the host's `unavailable`, a telemetry sample's `metrics`.
// Their keys come from the sensors themselves and from internal/sensormetrics'
// allowlist, so they cannot be a fixed GraphQL type without this schema
// becoming the thing that has to change when a sensor adds a counter.
var jsonScalar = graphql.NewScalar(graphql.ScalarConfig{
	Name:        "JSON",
	Description: "An arbitrary JSON object, for maps whose keys are not fixed by this schema.",
	Serialize:   func(value any) any { return value },
	ParseValue:  func(value any) any { return value },
	ParseLiteral: func(ast.Value) any {
		// Never an input. Accepting one would mean a client could push
		// untyped data into a resolver, and no query here takes a map.
		return nil
	},
})

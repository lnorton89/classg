// Package telemetry records host and sensor readings on a timer.
//
// /metrics exposes the current numbers, and on a field unit nothing scrapes it
// -- there is no Prometheus on a Pi in a field, and the whole point of the unit
// is that it works with the uplink unplugged. So without this there is no
// history, and the questions an operator actually has are historical: was it
// throttling when the adapter dropped off the bus, is the hopper's listening
// fraction falling as the evening goes on, has free disk been sliding for a
// week.
//
// Sampling is deliberately dumb. It takes whatever /system and /health report
// at that instant and writes it down; it computes no rates and smooths nothing,
// because a stored average cannot be un-averaged later and a raw sample can
// always be reduced by whoever draws the chart.
package telemetry

import (
	"context"
	"log/slog"
	"time"

	"github.com/classg/api/internal/health"
	"github.com/classg/api/internal/sensormetrics"
	"github.com/classg/api/internal/store"
	"github.com/classg/api/internal/system"
)

// DefaultInterval is a compromise between resolution and rows. At 60 s a week
// of history is about ten thousand rows, which is nothing for SQLite and still
// fine enough to see a thermal ramp.
const DefaultInterval = time.Minute

type Sampler struct {
	Store    store.Store
	Registry *health.Registry
	System   system.Options
	Interval time.Duration
}

func (s *Sampler) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	// One immediately, so a chart is not empty for the first minute after a
	// restart -- which is exactly when someone is most likely to be looking.
	s.sampleAndLog(ctx)

	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.sampleAndLog(ctx)
		}
	}
}

func (s *Sampler) sampleAndLog(ctx context.Context) {
	if err := s.Sample(ctx, time.Now()); err != nil {
		// A failed sample is a hole in a chart, not a reason to stop sampling
		// or to take anything else down with it.
		slog.Warn("recording a telemetry sample failed", "err", err)
	}
}

// Sample takes one reading and stores it. Exported so tests can drive it
// without waiting on a ticker.
//
// now must carry its monotonic reading -- it is handed to the health registry,
// which measures sensor liveness with it.
func (s *Sampler) Sample(ctx context.Context, now time.Time) error {
	info := system.Collect(s.System)

	// Uptime and version are not used here; this is the sensor list, read
	// through the same code path /health serves so the two cannot disagree
	// about which sensors were alive at a given moment.
	report := s.Registry.Snapshot(now, 0, "", nil)

	sensors := make([]store.TelemetrySensor, 0, len(report.Sensors))
	for _, sensor := range report.Sensors {
		sensors = append(sensors, store.TelemetrySensor{
			SensorID:   sensor.SensorID,
			SensorKind: sensor.SensorKind,
			Healthy:    sensor.Healthy,
			Metrics:    sensormetrics.Extract(sensor.Detail),
		})
	}

	return s.Store.InsertTelemetry(ctx, store.TelemetrySample{
		TS:             now.UTC(),
		CPUTempC:       info.Host.CPUTempC,
		Load1:          info.Host.Load1,
		MemAvailableKB: info.Host.MemAvailableKB,
		DiskFreeBytes:  signedBytes(info.Host.DiskFreeBytes),
		UptimeS:        info.Host.UptimeS,
		Sensors:        sensors,
	})
}

// signedBytes narrows statfs's unsigned counter to the signed integer SQLite
// stores. A filesystem large enough to overflow int64 does not exist; the
// conversion is here so the type mismatch is deliberate rather than a cast
// somebody has to re-derive later.
func signedBytes(v *uint64) *int64 {
	if v == nil {
		return nil
	}
	n := int64(*v)
	return &n
}

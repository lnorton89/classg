package health

import (
	"testing"
	"time"
)

var now = time.Date(2026, 8, 10, 14, 31, 2, 0, time.UTC)

const staleAfter = 30 * time.Second

// TestStatusTransitions is the test this service exists for.
//
// Every row is a state an operator can actually be in, and the assertion is
// that the API never reports "ok" when the honest answer is "I cannot see".
// The two rows that matter most are the pair at the top: identical empty
// skies, opposite verdicts, distinguished only by whether the radio is alive.
func TestStatusTransitions(t *testing.T) {
	type sensor struct {
		id       string
		kind     string
		declared bool
		// heartbeat is the age of the last heartbeat; negative means none ever.
		heartbeatAge time.Duration
		healthy      bool
	}
	tests := []struct {
		name             string
		sensors          []sensor
		detections5m     map[string]int
		fusionConfigured bool
		fusionConnected  bool
		wantStatus       string
		wantHealthy      map[string]bool
	}{
		{
			name:            "quiet sky: sensor healthy, nothing detected",
			sensors:         []sensor{{id: "wifi-0", kind: "wifi", heartbeatAge: 3 * time.Second, healthy: true}},
			detections5m:    map[string]int{},
			fusionConnected: true, fusionConfigured: true,
			wantStatus:  StatusOK,
			wantHealthy: map[string]bool{"wifi-0": true},
		},
		{
			name:            "broken detector: same empty sky, sensor unhealthy",
			sensors:         []sensor{{id: "wifi-0", kind: "wifi", heartbeatAge: 3 * time.Second, healthy: false}},
			detections5m:    map[string]int{},
			fusionConnected: true, fusionConfigured: true,
			wantStatus:  StatusDown,
			wantHealthy: map[string]bool{"wifi-0": false},
		},
		{
			name: "one of two sensors stale",
			sensors: []sensor{
				{id: "wifi-0", kind: "wifi", heartbeatAge: 3 * time.Second, healthy: true},
				{id: "sdr-0", kind: "sdr", heartbeatAge: 20 * time.Minute, healthy: true},
			},
			fusionConnected: true, fusionConfigured: true,
			wantStatus:  StatusDegraded,
			wantHealthy: map[string]bool{"wifi-0": true, "sdr-0": false},
		},
		{
			name: "sensor reports itself unhealthy while heartbeating",
			sensors: []sensor{
				{id: "wifi-0", kind: "wifi", heartbeatAge: 1 * time.Second, healthy: true},
				{id: "sdr-0", kind: "sdr", heartbeatAge: 1 * time.Second, healthy: false},
			},
			fusionConnected: true, fusionConfigured: true,
			wantStatus:  StatusDegraded,
			wantHealthy: map[string]bool{"wifi-0": true, "sdr-0": false},
		},
		{
			name: "all sensors stale",
			sensors: []sensor{
				{id: "wifi-0", kind: "wifi", heartbeatAge: time.Hour, healthy: true},
				{id: "sdr-0", kind: "sdr", heartbeatAge: time.Hour, healthy: true},
			},
			fusionConnected: true, fusionConfigured: true,
			wantStatus:  StatusDown,
			wantHealthy: map[string]bool{"wifi-0": false, "sdr-0": false},
		},
		{
			name:            "declared sensor that never started",
			sensors:         []sensor{{id: "sdr-0", kind: "sdr", declared: true, heartbeatAge: -1}},
			fusionConnected: true, fusionConfigured: true,
			wantStatus:  StatusDown,
			wantHealthy: map[string]bool{"sdr-0": false},
		},
		{
			name: "declared sensor that never started, alongside a live one",
			sensors: []sensor{
				{id: "wifi-0", kind: "wifi", heartbeatAge: 2 * time.Second, healthy: true},
				{id: "sdr-0", kind: "sdr", declared: true, heartbeatAge: -1},
			},
			fusionConnected: true, fusionConfigured: true,
			wantStatus:  StatusDegraded,
			wantHealthy: map[string]bool{"wifi-0": true, "sdr-0": false},
		},
		{
			name:            "no sensors at all is not ok",
			sensors:         nil,
			fusionConnected: true, fusionConfigured: true,
			wantStatus: StatusDown,
		},
		{
			name:             "healthy sensors but fusion is not connected",
			sensors:          []sensor{{id: "wifi-0", kind: "wifi", heartbeatAge: 2 * time.Second, healthy: true}},
			fusionConfigured: true, fusionConnected: false,
			wantStatus:  StatusDegraded,
			wantHealthy: map[string]bool{"wifi-0": true},
		},
		{
			name:             "fusion not configured does not degrade",
			sensors:          []sensor{{id: "wifi-0", kind: "wifi", heartbeatAge: 2 * time.Second, healthy: true}},
			fusionConfigured: false, fusionConnected: false,
			wantStatus:  StatusOK,
			wantHealthy: map[string]bool{"wifi-0": true},
		},
		{
			name:             "detections seen counts as detections_5m, not as health",
			sensors:          []sensor{{id: "wifi-0", kind: "wifi", heartbeatAge: 2 * time.Second, healthy: true}},
			detections5m:     map[string]int{"wifi-0": 412},
			fusionConfigured: true, fusionConnected: true,
			wantStatus:  StatusOK,
			wantHealthy: map[string]bool{"wifi-0": true},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRegistry(staleAfter)
			for _, s := range tc.sensors {
				if s.declared {
					r.Expect(s.id, s.kind)
					continue
				}
				r.Heartbeat(Heartbeat{
					SensorID:   s.id,
					SensorKind: s.kind,
					Healthy:    s.healthy,
					TS:         now.Add(-s.heartbeatAge),
				})
			}
			r.SetFusionState(tc.fusionConfigured, tc.fusionConnected, "")

			rep := r.Snapshot(now, time.Hour, "0.1.0", tc.detections5m)

			if rep.Status != tc.wantStatus {
				t.Fatalf("status: got %q want %q", rep.Status, tc.wantStatus)
			}
			if len(rep.Sensors) != len(tc.wantHealthy) {
				t.Fatalf("sensor count: got %d want %d", len(rep.Sensors), len(tc.wantHealthy))
			}
			for _, s := range rep.Sensors {
				want, ok := tc.wantHealthy[s.SensorID]
				if !ok {
					t.Fatalf("unexpected sensor %q in report", s.SensorID)
				}
				if s.Healthy != want {
					t.Errorf("sensor %s healthy: got %v want %v (reason %q)", s.SensorID, s.Healthy, want, s.Reason)
				}
				if want := tc.detections5m[s.SensorID]; s.Detections5m != want {
					t.Errorf("sensor %s detections_5m: got %d want %d", s.SensorID, s.Detections5m, want)
				}
			}
		})
	}
}

// TestUnhealthySensorAlwaysCarriesAReason guards the operator-facing half of
// the contract: "healthy:false" without a reason tells nobody what to fix.
func TestUnhealthySensorAlwaysCarriesAReason(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*Registry)
	}{
		{"never started", func(r *Registry) { r.Expect("sdr-0", "sdr") }},
		{"stale heartbeat", func(r *Registry) {
			r.Heartbeat(Heartbeat{SensorID: "sdr-0", SensorKind: "sdr", Healthy: true, TS: now.Add(-time.Hour)})
		}},
		{"self-reported", func(r *Registry) {
			r.Heartbeat(Heartbeat{
				SensorID: "sdr-0", SensorKind: "sdr", Healthy: false, TS: now,
				Detail: map[string]any{"reason": "device not found"},
			})
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRegistry(staleAfter)
			tc.setup(r)
			rep := r.Snapshot(now, time.Hour, "0.1.0", nil)
			if len(rep.Sensors) != 1 {
				t.Fatalf("want 1 sensor, got %d", len(rep.Sensors))
			}
			s := rep.Sensors[0]
			if s.Healthy {
				t.Fatal("sensor should be unhealthy")
			}
			if s.Reason == "" {
				t.Fatal("an unhealthy sensor must say why")
			}
		})
	}
}

// TestReasonIsLiftedOutOfDetail pins the shape adaptation for
// classg_wifi/bus.py, which nests the reason inside detail.
func TestReasonIsLiftedOutOfDetail(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Heartbeat(Heartbeat{
		SensorID: "wifi-0", SensorKind: "wifi", Healthy: false, TS: now,
		Detail: map[string]any{"reason": "capture loop not implemented", "frames_seen": float64(0)},
	})
	rep := r.Snapshot(now, time.Hour, "0.1.0", nil)
	s := rep.Sensors[0]
	if s.Reason != "capture loop not implemented" {
		t.Fatalf("reason: got %q", s.Reason)
	}
	if _, still := s.Detail["reason"]; still {
		t.Fatal("reason should be promoted out of detail, not duplicated")
	}
	if s.Detail["frames_seen"] != float64(0) {
		t.Fatalf("the rest of detail should survive: %+v", s.Detail)
	}
}

// TestSecondsSinceHeartbeat is what a caller uses to judge staleness itself.
func TestSecondsSinceHeartbeat(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: now.Add(-90 * time.Second)})
	rep := r.Snapshot(now, time.Hour, "0.1.0", nil)
	s := rep.Sensors[0]
	if s.SecondsSinceHeartbeat == nil || *s.SecondsSinceHeartbeat != 90 {
		t.Fatalf("seconds_since_heartbeat: %v", s.SecondsSinceHeartbeat)
	}
	if s.LastHeartbeat == nil {
		t.Fatal("last_heartbeat must be present once a heartbeat has arrived")
	}
}

// TestRestoreKeepsDeadSensorsVisible: an api restart must not make a broken
// radio disappear and turn a broken detector back into an apparently quiet sky.
func TestRestoreKeepsDeadSensorsVisible(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Restore("sdr-0", "sdr", now.Add(-2*time.Hour), "device not found")

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusDown {
		t.Fatalf("status: got %q want down", rep.Status)
	}
	if len(rep.Sensors) != 1 || rep.Sensors[0].Healthy {
		t.Fatalf("restored sensor should be present and unhealthy: %+v", rep.Sensors)
	}
}

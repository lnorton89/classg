package health

import (
	"strings"
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
					r.Expect(s.id, s.kind, false)
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
		{"never started", func(r *Registry) { r.Expect("sdr-0", "sdr", false) }},
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

// A unit built without an SDR must not report degraded forever. An operator who
// learns to ignore a standing warning ignores a real one too.
func TestUnfittedOptionalSensorDoesNotDegrade(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("wifi-0", "wifi", false)
	r.Expect("sdr-0", "sdr", true)
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: now})

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusOK {
		t.Fatalf("status: got %q want ok", rep.Status)
	}

	// Listed, not hidden: an operator must still be able to see the unit has no
	// SDR rather than having to infer it from an absence.
	var sdr *Sensor
	for i := range rep.Sensors {
		if rep.Sensors[i].SensorID == "sdr-0" {
			sdr = &rep.Sensors[i]
		}
	}
	if sdr == nil {
		t.Fatal("optional sensor should still appear in the report")
	}
	if !sdr.Optional {
		t.Error("optional flag not reported")
	}
	if sdr.Reason != "not fitted" {
		t.Errorf("reason: got %q want %q", sdr.Reason, "not fitted")
	}
}

// The other half of the contract, and the one that makes it safe: optional
// means "may be absent", never "may fail quietly". A radio that reported and
// then stopped is exactly the failure ADR-0003 exists to surface.
func TestOptionalSensorThatDiesStillDegrades(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("wifi-0", "wifi", false)
	r.Expect("sdr-0", "sdr", true)
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: now})
	// The SDR was fitted and working, then went quiet.
	r.Heartbeat(Heartbeat{SensorID: "sdr-0", SensorKind: "sdr", Healthy: true, TS: now.Add(-time.Hour)})

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusDegraded {
		t.Fatalf("status: got %q want degraded", rep.Status)
	}
}

// Restore counts as having been seen: a sensor known from storage was fitted at
// some point, so an api restart must not downgrade it to "not fitted".
func TestRestoredOptionalSensorIsNotTreatedAsUnfitted(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("sdr-0", "sdr", true)
	r.Restore("sdr-0", "sdr", now.Add(-2*time.Hour), "device not found")

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusDown {
		t.Fatalf("status: got %q want down", rep.Status)
	}
	if rep.Sensors[0].Reason == "not fitted" {
		t.Error("a sensor that has reported before must not read as never fitted")
	}
}

// An optional sensor is the only declared one and is absent: nothing is known
// about the sky, which is `down` rather than `ok`. Guards against the exclusion
// accidentally manufacturing an all-clear from an empty tally.
func TestOnlyUnfittedOptionalSensorIsDown(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("sdr-0", "sdr", true)

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusDown {
		t.Fatalf("status: got %q want down", rep.Status)
	}
}

// A second Wi-Fi receiver is not optional the way a second radio KIND is.
//
// The two Wi-Fi radios share a split channel plan -- channels-primary.yaml is
// 6/1/11 only because channels-sweep.yaml takes the rest, and
// channels-sweep.yaml omits channel 6 because the primary camps there. Declare
// both and lose one, and the survivor is running a plan written for coverage it
// no longer has: no 5 GHz at all, or no channel 6 at all. "not fitted" is the
// answer for an SDR that was never bought. It is the wrong answer here.
func TestDeclaredSecondWifiReceiverThatNeverReportsDegrades(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("wifi-0", "wifi", false)
	r.Expect("wifi-1", "wifi", true)
	// The survivor is on the split plan: it found its companion at startup, or
	// was never told it had one. Either way it is not covering the whole plan.
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: now,
		Detail: map[string]any{"plan": "channels-primary.yaml", "plan_fallback": false}})

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusDegraded {
		t.Fatalf("status: got %q want degraded", rep.Status)
	}
	got := sensorByID(t, rep, "wifi-1")
	if got.Reason == "not fitted" {
		t.Error("a missing Wi-Fi receiver leaves a coverage hole; the reason must say so")
	}
	if !strings.Contains(got.Reason, "split") {
		t.Errorf("reason %q does not name the split plan", got.Reason)
	}
}

// The other half, and the one that keeps the warning honest: on a genuine
// single-adapter build the survivor widens to the full plan and there is no
// hole. Reporting degraded forever here would be the standing warning that
// teaches an operator to ignore the real one.
func TestWidenedWifiReceiverMakesAMissingCompanionHarmless(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("wifi-0", "wifi", false)
	r.Expect("wifi-1", "wifi", true)
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: now,
		Detail: map[string]any{"plan": "channels.yaml", "plan_fallback": true}})

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusOK {
		t.Fatalf("status: got %q want ok", rep.Status)
	}
	if got := sensorByID(t, rep, "wifi-1"); !strings.Contains(got.Reason, "widened") {
		t.Errorf("reason %q does not say the survivor widened", got.Reason)
	}
}

// A widened receiver only speaks for coverage while it is alive. Once it goes
// stale it proves nothing, and the companion's absence is a hole again --
// otherwise a dead radio's last heartbeat would keep vouching for the sky.
func TestAStaleWidenedReceiverStopsVouchingForCoverage(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("wifi-0", "wifi", false)
	r.Expect("wifi-1", "wifi", true)
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true,
		TS: now.Add(-time.Hour), At: now.Add(-time.Hour),
		Detail: map[string]any{"plan_fallback": true}})

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if got := sensorByID(t, rep, "wifi-1"); !strings.Contains(got.Reason, "split") {
		t.Errorf("reason %q: a stale receiver must not vouch for coverage", got.Reason)
	}
}

// The rule is about the Wi-Fi pair's shared channel plan, so it must not leak
// onto other hardware. An SDR is still allowed to be absent.
func TestTheCoverageRuleDoesNotTouchOtherSensorKinds(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("wifi-0", "wifi", false)
	r.Expect("sdr-0", "sdr", true)
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: now,
		Detail: map[string]any{"plan_fallback": false}})

	rep := r.Snapshot(now, time.Minute, "0.1.0", nil)
	if rep.Status != StatusOK {
		t.Fatalf("status: got %q want ok", rep.Status)
	}
	if got := sensorByID(t, rep, "sdr-0"); got.Reason != "not fitted" {
		t.Errorf("reason: got %q want %q", got.Reason, "not fitted")
	}
}

// An undeclared second receiver is not a missing one. A unit that only ever had
// one radio and says so must stay `ok` whatever plan it is running.
func TestUndeclaredSecondWifiReceiverIsNotAFault(t *testing.T) {
	r := NewRegistry(staleAfter)
	r.Expect("wifi-0", "wifi", false)
	r.Heartbeat(Heartbeat{SensorID: "wifi-0", SensorKind: "wifi", Healthy: true, TS: now,
		Detail: map[string]any{"plan_fallback": false}})

	if rep := r.Snapshot(now, time.Minute, "0.1.0", nil); rep.Status != StatusOK {
		t.Fatalf("status: got %q want ok", rep.Status)
	}
}

func sensorByID(t *testing.T, rep Report, id string) Sensor {
	t.Helper()
	for _, s := range rep.Sensors {
		if s.SensorID == id {
			return s
		}
	}
	t.Fatalf("%s missing from the report", id)
	return Sensor{}
}

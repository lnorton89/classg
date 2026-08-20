package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/classg/api/internal/proc"
)

// errRestartUnavailable means the machine cannot restart units, as opposed to
// the unit failing to restart.
var errRestartUnavailable = errors.New("cannot restart sensor units")

// unitFor maps a known sensor identity to its systemd unit. Most sensor kinds
// have one process under ADR-0003; the second Wi-Fi receiver is deliberately a
// separate process so a failed sweeping adapter can be restarted without
// interrupting the channel-6 receiver.
func unitFor(sensorID, kind string) string {
	if kind == "wifi" && sensorID == "wifi-1" {
		return "classg-sensor-wifi-tplink.service"
	}
	return "classg-sensor-" + kind + ".service"
}

// hasOwnUnit reports whether a sensor kind is a separate process under ADR-0003.
//
// `net` sources are not. A network feed is a goroutine inside fusion, so
// classg-sensor-net.service does not exist and never will -- offering a restart
// button for it would fail at the systemd layer with an error that says nothing
// about the actual problem, which is almost always the uplink. Restart fusion.
func hasOwnUnit(kind string) bool { return kind != "net" }

func restartCommandString(argv []string, unit string) string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = strings.ReplaceAll(a, "%s", unit)
	}
	return strings.Join(out, " ")
}

func restartAvailability(argv []string) (bool, string) {
	if len(argv) == 0 {
		return false, "no restart command configured"
	}
	if _, err := exec.LookPath(argv[0]); err != nil {
		return false, argv[0] + " is not available in the API runtime"
	}
	return true, ""
}

// SystemdSensors restarts sensors through the configured command.
//
// The command template comes from configuration rather than the request, and
// the only substitution is a unit name derived from a sensor kind that is
// already constrained to the schema enum. There is no shell, so the template
// cannot be turned into a second command by anything a client sends.
type SystemdSensors struct {
	Argv []string
}

// restartTimeout bounds the restart command. systemctl talks to PID 1 over
// D-Bus, and a hung D-Bus used to pin the handler goroutine forever -- the
// same wedge the capture preflight guards its iw calls against. Generous,
// because a unit's ExecStop is allowed a moment to run; but finite, because a
// goroutine per click against a dead D-Bus never comes back.
const restartTimeout = 30 * time.Second

func (s SystemdSensors) Restart(sensorID string, sensorKind string) error {
	if len(s.Argv) == 0 {
		return fmt.Errorf("%w: no restart command configured", errRestartUnavailable)
	}
	unit := unitFor(sensorID, sensorKind)
	argv := make([]string, len(s.Argv))
	for i, a := range s.Argv {
		argv[i] = strings.ReplaceAll(a, "%s", unit)
	}
	if _, err := exec.LookPath(argv[0]); err != nil {
		return fmt.Errorf("%w: %s is not available", errRestartUnavailable, argv[0])
	}
	ctx, cancel := context.WithTimeout(context.Background(), restartTimeout)
	defer cancel()
	out, err := proc.Command(ctx, argv[0], argv[1:]...).CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("restarting %s timed out after %s; systemd may be wedged", unit, restartTimeout)
	}
	if err != nil {
		return fmt.Errorf("restarting %s failed: %v: %s", unit, err, strings.TrimSpace(string(out)))
	}
	return nil
}

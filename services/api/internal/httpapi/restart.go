package httpapi

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// errRestartUnavailable means the machine cannot restart units, as opposed to
// the unit failing to restart.
var errRestartUnavailable = errors.New("cannot restart sensor units")

// unitFor maps a sensor kind to its systemd unit, named as in ADR-0003.
func unitFor(kind string) string { return "classg-sensor-" + kind + ".service" }

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
// already constrained to wifi|sdr|ble. There is no shell, so the template
// cannot be turned into a second command by anything a client sends.
type SystemdSensors struct {
	Argv []string
}

func (s SystemdSensors) Restart(_ string, sensorKind string) error {
	if len(s.Argv) == 0 {
		return fmt.Errorf("%w: no restart command configured", errRestartUnavailable)
	}
	unit := unitFor(sensorKind)
	argv := make([]string, len(s.Argv))
	for i, a := range s.Argv {
		argv[i] = strings.ReplaceAll(a, "%s", unit)
	}
	if _, err := exec.LookPath(argv[0]); err != nil {
		return fmt.Errorf("%w: %s is not available", errRestartUnavailable, argv[0])
	}
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("restarting %s failed: %v: %s", unit, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Package proc is how this service starts subprocesses.
//
// It exists for one line -- cmd.WaitDelay -- and that line is the difference
// between the timeouts in this repo bounding anything and merely appearing to.
//
// Every exec here already ran under a context with a deadline, each with a
// comment naming the wedge it was guarding against:
//
//	"a wedged mt7921u can hang iw inside the kernel"      (capture preflight)
//	"a wedged USB device blocks a read forever"           (spectrum sweep)
//	"a hung D-Bus used to pin the handler goroutine"      (sensor restart)
//	"the api sets no WriteTimeout"                        (capture analysis)
//
// None of them held. exec.CommandContext kills the direct child when the
// deadline passes, but Wait does not return until the output pipes close, and
// those stay open while anything still holds them: a grandchild that inherited
// them, or -- exactly the case every comment above describes -- a process stuck
// in an uninterruptible kernel wait, where SIGKILL is delivered and not acted
// on until the driver returns. A wedged adapter is the scenario, and a wedged
// adapter is the scenario in which the bound fails.
//
// Measured, not reasoned about: with a child that genuinely blocks, an Analyze
// with a 300ms deadline ran for 120 seconds. With WaitDelay it returns in 5.3.
//
// The cost when nothing is wrong is zero. WaitDelay only elapses after the
// context is already done and the process already killed, and a healthy child's
// output is flushed by the time it exits.
package proc

import (
	"context"
	"os/exec"
	"time"
)

// WaitDelay is how long Wait may keep waiting for output after the process has
// been killed, before giving up and closing the pipes itself.
//
// Five seconds, which is generous for "flush what you already wrote" and short
// against every timeout that precedes it -- the shortest is the 10s on iw.
const WaitDelay = 5 * time.Second

// Command is exec.CommandContext with the delay set.
//
// Use it for every subprocess. An exec.CommandContext anywhere else in this
// service is a timeout that a wedged device can outlast.
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = WaitDelay
	return cmd
}

package proc

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// blocker writes a script whose CHILD outlives it. That is the shape that
// breaks a context deadline: killing the direct process does not close the
// pipes its child inherited, so Wait keeps waiting on output nobody is going
// to send.
func blocker(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no shell")
	}
	path := filepath.Join(t.TempDir(), "blocker.sh")
	// `sleep` is a separate process, so SIGKILL to the shell leaves it holding
	// the inherited stdout and stderr.
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 120\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// The whole reason this package exists.
func TestADeadlineActuallyBoundsTheCall(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	cmd := Command(ctx, blocker(t))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := cmd.Run()
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("a killed process returned no error")
	}
	// Deadline plus WaitDelay, with room for a slow Pi. The child sleeps 120s,
	// so anything approaching that means the bound did nothing.
	if elapsed > 30*time.Second {
		t.Fatalf("Run took %s; the deadline did not bound it", elapsed)
	}
	if ctx.Err() == nil {
		t.Error("the context was not the reason it stopped")
	}
}

// Without the delay, the same call runs to the child's own completion. Not a
// hypothetical: this is what every timeout in this service did before.
func TestWithoutTheDelayTheDeadlineIsCosmetic(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out a blocked child on purpose")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	// Deliberately NOT proc.Command: this is the shape being argued against.
	cmd := exec.CommandContext(ctx, blocker(t))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan struct{})
	go func() {
		_ = cmd.Run()
		close(done)
	}()

	select {
	case <-done:
		t.Error("the plain CommandContext returned quickly; if Go has fixed this, " +
			"proc.Command and this test can go")
	case <-time.After(3 * time.Second):
		// Still blocked fifteen deadlines later, which is the point.
	}
	// Leave the child to its own timeout rather than waiting 120s for it.
}

// A process that exits on its own must not pay the delay.
func TestAHealthyCommandIsUnaffected(t *testing.T) {
	if _, err := exec.LookPath("echo"); err != nil {
		t.Skip("no echo")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	start := time.Now()
	out, err := Command(ctx, "echo", "hello").Output()
	elapsed := time.Since(start)

	if err != nil {
		t.Fatal(err)
	}
	if string(bytes.TrimSpace(out)) != "hello" {
		t.Errorf("output was %q", out)
	}
	if elapsed > WaitDelay {
		t.Errorf("a healthy command took %s; WaitDelay is being paid on success", elapsed)
	}
}

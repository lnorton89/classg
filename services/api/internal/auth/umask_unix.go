//go:build unix

package auth

import "syscall"

// syscallUmask exists so localagent_test.go can prove the token file's mode is
// set explicitly rather than inherited from whatever umask the process happens
// to have. Not test-only code in a _test file, because syscall.Umask does not
// exist on Windows and the build tag has to live on a file of its own.
func syscallUmask(mask int) int { return syscall.Umask(mask) }

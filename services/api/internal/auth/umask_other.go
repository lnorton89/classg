//go:build !unix

package auth

// syscallUmask is a no-op where there is no umask. The mode assertion in
// localagent_test.go is then weaker than it is on the Pi, which is the platform
// that matters -- and `go vet` on a developer's Windows checkout still builds.
func syscallUmask(int) int { return 0 }

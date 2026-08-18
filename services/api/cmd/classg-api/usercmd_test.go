package main

import (
	"os"
	"strings"
	"testing"
)

// A password must never be an argument, because argv is world-readable in ps
// and lands in shell history. The flag set has no --password for that reason,
// and this is the test that notices if one appears.
func TestNoPasswordFlagExists(t *testing.T) {
	src, err := os.ReadFile("usercmd.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(src), `String("password"`) {
		t.Fatal("a --password flag was added; a command line is visible in ps and kept in history")
	}
}

func TestReadPasswordFromStdin(t *testing.T) {
	cases := map[string]string{
		// `echo | classg-api user add --password-stdin` is the documented
		// form, and echo adds the newline.
		"hunter2\n":   "hunter2",
		"hunter2\r\n": "hunter2",
		"hunter2":     "hunter2",
		// Nothing else is trimmed: spaces inside a passphrase are the
		// operator's business, and silently changing what they typed means a
		// password that cannot be typed back in.
		"  spaced  \n": "  spaced  ",
	}
	for input, want := range cases {
		got := withStdin(t, input, func() string {
			p, generated, err := readOrGeneratePassword(true)
			if err != nil {
				t.Fatal(err)
			}
			if generated {
				t.Fatal("reported a generated password when reading stdin")
			}
			return p
		})
		if got != want {
			t.Errorf("stdin %q -> %q, want %q", input, got, want)
		}
	}
}

func TestGeneratedPasswordsAreLongAndDistinct(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		p, generated, err := readOrGeneratePassword(false)
		if err != nil {
			t.Fatal(err)
		}
		if !generated {
			t.Fatal("did not report the password as generated")
		}
		// 20 random bytes, base64url without padding.
		if len(p) < 24 {
			t.Fatalf("generated password is only %d characters", len(p))
		}
		if seen[p] {
			t.Fatal("generated the same password twice")
		}
		seen[p] = true
	}
}

func withStdin(t *testing.T, input string, fn func() string) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = orig })

	go func() {
		_, _ = w.WriteString(input)
		_ = w.Close()
	}()
	out := fn()
	_ = r.Close()
	return out
}

package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDotEnvWalksUpAndDoesNotOverrideProcessEnv(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "services", "api")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte(
		"CLASSG_LISTEN=:9191\nCLASSG_STORE=memory\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}

	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLASSG_STORE", "libsql")
	_ = os.Unsetenv("CLASSG_LISTEN")
	t.Cleanup(func() { _ = os.Unsetenv("CLASSG_LISTEN") })

	loaded, err := LoadDotEnv()
	if err != nil {
		t.Fatal(err)
	}
	if loaded != filepath.Join(root, ".env") {
		t.Fatalf("loaded %q", loaded)
	}
	if got := os.Getenv("CLASSG_LISTEN"); got != ":9191" {
		t.Fatalf("CLASSG_LISTEN=%q", got)
	}
	if got := os.Getenv("CLASSG_STORE"); got != "libsql" {
		t.Fatalf("explicit environment was overwritten: %q", got)
	}
}

func TestLoadDotEnvExplicitMissingFileFails(t *testing.T) {
	t.Setenv("CLASSG_ENV_FILE", filepath.Join(t.TempDir(), "missing.env"))
	if _, err := LoadDotEnv(); err == nil {
		t.Fatal("missing CLASSG_ENV_FILE was silently ignored")
	}
}

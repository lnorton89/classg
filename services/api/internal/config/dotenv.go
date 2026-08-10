package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

// LoadDotEnv loads CLASSG_ENV_FILE when explicitly set, otherwise the nearest
// .env found by walking from the working directory toward the filesystem root.
// godotenv.Load never replaces variables already present in the process
// environment, so deployment/systemd values remain authoritative.
func LoadDotEnv() (string, error) {
	if explicit := os.Getenv("CLASSG_ENV_FILE"); explicit != "" {
		path, err := filepath.Abs(explicit)
		if err != nil {
			return "", fmt.Errorf("CLASSG_ENV_FILE: %w", err)
		}
		if err := godotenv.Load(path); err != nil {
			return "", fmt.Errorf("CLASSG_ENV_FILE %q: %w", path, err)
		}
		return path, nil
	}

	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("locating .env: %w", err)
	}
	for {
		candidate := filepath.Join(dir, ".env")
		if _, err := os.Stat(candidate); err == nil {
			if err := godotenv.Load(candidate); err != nil {
				return "", fmt.Errorf("loading %q: %w", candidate, err)
			}
			return candidate, nil
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("checking %q: %w", candidate, err)
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return "", nil
		}
		dir = parent
	}
}

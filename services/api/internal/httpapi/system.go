package httpapi

import (
	"net/http"
	"path/filepath"

	"github.com/classg/api/internal/system"
)

// handleSystem backs the UI's About panel: what this binary is, how it is
// configured, and how the Pi underneath is doing.
//
// Separate from /health rather than folded into it. /health answers one
// question — is the sky quiet or is the detector broken — and is polled hard
// by the UI, classgctl and anything watching the unit. Hanging build strings
// and a statfs off that path would make the hot endpoint slower to answer the
// only question it exists for.
func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	info := system.Collect(system.Options{
		Version:    s.cfg.Version,
		Listen:     s.cfg.Listen,
		Store:      s.cfg.Store,
		UIDir:      s.cfg.UIDir,
		CaptureDir: s.cfg.CaptureDir,
		TursoURL:   s.cfg.TursoURL,
		// The filesystem detections actually land on. The container's root
		// fills at a different rate and is not what an operator is asking
		// about when they ask how much room is left.
		DiskPath: diskPath(s.cfg.DBPath, s.cfg.CaptureDir),
	})
	writeJSON(w, http.StatusOK, info)
}

// diskPath prefers the database's filesystem and falls back to the capture
// directory, so an in-memory store still reports something useful.
func diskPath(dbPath, captureDir string) string {
	if dbPath != "" {
		return filepath.Dir(dbPath)
	}
	return captureDir
}

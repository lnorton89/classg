package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/classg/api/internal/apierr"
)

// staticHandler serves the built web app from CLASSG_UI_DIR when it exists.
//
// This is what makes the Pi deployment one binary and no Node runtime. When
// the directory is absent -- a bare API deployment, or a checkout where the UI
// has not been built -- every non-API path returns the same error envelope as
// everything else rather than a blank page that looks like a broken app.
func (s *Server) staticHandler() http.Handler {
	dir := s.cfg.UIDir
	index := filepath.Join(dir, "index.html")

	if fi, err := os.Stat(index); err != nil || fi.IsDir() {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			apierr.Write(w, apierr.NotFound(
				"no web app is installed (looked for "+index+"); the API is at "+BasePath))
		})
	}

	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		full := filepath.Join(dir, clean)

		// Single-page app fallback: a deep link like /tracks/01J8… is a client
		// route, not a file. Serve index.html and let the app route it.
		// Anything with an extension is a real asset request, and a miss there
		// should 404 rather than return HTML with a 200, which is the failure
		// mode that produces "unexpected token '<'" in a browser console.
		if fi, err := os.Stat(full); err != nil || fi.IsDir() {
			if filepath.Ext(clean) == "" {
				http.ServeFile(w, r, index)
				return
			}
		}
		files.ServeHTTP(w, r)
	})
}

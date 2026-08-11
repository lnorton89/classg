package capture

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/ulid"
)

// filenameStamp matches the timestamps this project's capture tooling writes.
//
//	scripts/first-capture.sh :  20260810-141223-dji-first-flight.pcap
//	Manager.Start            :  2026-08-10-141223-sensor-capture.pcap
var filenameStamp = regexp.MustCompile(`^(\d{4})-?(\d{2})-?(\d{2})-(\d{2})(\d{2})(\d{2})-?(.*)$`)

// AdoptOrphans registers PCAPs sitting in the capture directory that have no
// database record, so they appear in the captures list like any other.
//
// Why this is needed: a capture record is created by Manager.Start, so only
// API-initiated captures were ever listed. But docs/ops/06-first-capture.md
// tells an operator to record Milestone 0 with scripts/first-capture.sh, and
// docker/README.md documents replaying that file -- so the project's own
// documented workflow produced captures the UI then claimed did not exist.
//
// Idempotent: matching is by filename, so a capture already known is skipped.
// Safe to call on every startup.
func (m *Manager) AdoptOrphans(ctx context.Context) (int, error) {
	entries, err := os.ReadDir(m.opts.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil // no capture directory yet is not a problem
		}
		return 0, fmt.Errorf("reading capture directory: %w", err)
	}

	known, err := m.store.ListCaptures(ctx)
	if err != nil {
		return 0, fmt.Errorf("listing captures: %w", err)
	}
	seen := make(map[string]model.Capture, len(known))
	for _, c := range known {
		seen[c.Filename] = c
	}

	var candidates []os.DirEntry
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".pcap") {
			continue
		}
		candidates = append(candidates, e)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Name() < candidates[j].Name() })

	changed := 0
	for _, e := range candidates {
		existing, isKnown := seen[e.Name()]

		// Repair, not just adopt. A record written before frame counting worked
		// reports 0 frames for a perfectly good capture, and idempotency alone
		// would leave that wrong forever. Recount only when the stored value is
		// zero, so a deliberate value is never overwritten.
		if isKnown {
			if existing.FrameCount > 0 {
				continue
			}
			n := countFrames(filepath.Join(m.opts.Dir, e.Name()))
			if n == 0 {
				continue
			}
			existing.FrameCount = n
			if info, err := e.Info(); err == nil {
				existing.SizeBytes = info.Size()
			}
			if err := m.store.PutCapture(ctx, existing); err != nil {
				return changed, fmt.Errorf("repairing %s: %w", e.Name(), err)
			}
			slog.Info("repaired capture frame count", "file", e.Name(), "frames", n)
			changed++
			continue
		}

		c, err := m.describe(e)
		if err != nil {
			slog.Warn("skipping unreadable capture", "file", e.Name(), "err", err)
			continue
		}
		if err := m.store.PutCapture(ctx, c); err != nil {
			return changed, fmt.Errorf("adopting %s: %w", e.Name(), err)
		}
		slog.Info("adopted existing capture",
			"file", c.Filename, "frames", c.FrameCount, "bytes", c.SizeBytes)
		changed++
	}
	return changed, nil
}

func (m *Manager) describe(e os.DirEntry) (model.Capture, error) {
	info, err := e.Info()
	if err != nil {
		return model.Capture{}, err
	}
	path := filepath.Join(m.opts.Dir, e.Name())

	started, label := parseFilename(e.Name(), info.ModTime().UTC())

	return model.Capture{
		CaptureID: ulid.New(started),
		Filename:  e.Name(),
		// Anything already on disk has finished; nothing here is still running.
		State:      model.CaptureCompleted,
		StartedAt:  started,
		EndedAt:    ptr(info.ModTime().UTC()),
		SizeBytes:  info.Size(),
		FrameCount: countFrames(path),
		Label:      label,
		// Iface, Channel and DurationS stay zero: they are not recoverable from
		// a file, and inventing plausible values would be worse than admitting
		// they are unknown.
	}, nil
}

// parseFilename recovers the capture time and label from the name, falling back
// to the file's modification time when it does not match a known pattern.
func parseFilename(name string, fallback time.Time) (time.Time, string) {
	base := strings.TrimSuffix(name, filepath.Ext(name))

	mm := filenameStamp.FindStringSubmatch(base)
	if mm == nil {
		return fallback, base
	}
	stamp := fmt.Sprintf("%s-%s-%sT%s:%s:%sZ", mm[1], mm[2], mm[3], mm[4], mm[5], mm[6])
	t, err := time.Parse(time.RFC3339, stamp)
	if err != nil {
		return fallback, base
	}
	label := strings.Trim(mm[7], "-")
	if label == "" {
		label = "capture"
	}
	return t.UTC(), label
}

func ptr[T any](v T) *T { return &v }

package capture

import (
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/classg/api/internal/store/memstore"
)

func writePcap(t *testing.T, dir, name string) {
	t.Helper()
	// A valid classic-PCAP global header (linktype 127, radiotap) and nothing
	// else: enough for countFrames to read it without inventing frames.
	header := []byte{
		0xd4, 0xc3, 0xb2, 0xa1, 0x02, 0x00, 0x04, 0x00,
		0, 0, 0, 0, 0, 0, 0, 0,
		0xff, 0xff, 0, 0, 0x7f, 0, 0, 0,
	}
	if err := os.WriteFile(filepath.Join(dir, name), header, 0o600); err != nil {
		t.Fatal(err)
	}
}

func newManager(t *testing.T) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	return NewManager(memstore.New(), Options{Dir: dir}), dir
}

func TestAdoptsCaptureFromTheDocumentedScript(t *testing.T) {
	// The exact filename scripts/first-capture.sh produces, which the Milestone
	// 0 docs tell an operator to use.
	m, dir := newManager(t)
	writePcap(t, dir, "20260810-141223-dji-first-flight.pcap")

	n, err := m.AdoptOrphans(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("adopted %d, want 1", n)
	}

	got, err := m.store.ListCaptures(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("store has %d captures", len(got))
	}
	c := got[0]
	if c.Filename != "20260810-141223-dji-first-flight.pcap" {
		t.Fatalf("filename = %q", c.Filename)
	}
	if c.State != "completed" {
		t.Fatalf("state = %q; anything already on disk has finished", c.State)
	}
	want := time.Date(2026, 8, 10, 14, 12, 23, 0, time.UTC)
	if !c.StartedAt.Equal(want) {
		t.Fatalf("StartedAt = %s, want %s (recovered from the filename)", c.StartedAt, want)
	}
	if c.Label != "dji-first-flight" {
		t.Fatalf("label = %q", c.Label)
	}
	// Unknowable from a file. Inventing plausible values would be worse.
	if c.Iface != "" || c.Channel != 0 {
		t.Fatalf("iface/channel should be unset, got %q/%d", c.Iface, c.Channel)
	}
}

func TestAdoptIsIdempotent(t *testing.T) {
	m, dir := newManager(t)
	writePcap(t, dir, "20260810-141223-dji-first-flight.pcap")
	ctx := context.Background()

	if _, err := m.AdoptOrphans(ctx); err != nil {
		t.Fatal(err)
	}
	n, err := m.AdoptOrphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("second run adopted %d; it must be safe on every startup", n)
	}
	got, _ := m.store.ListCaptures(ctx)
	if len(got) != 1 {
		t.Fatalf("duplicated the capture: %d records", len(got))
	}
}

func TestAdoptHandlesBothFilenameFormats(t *testing.T) {
	m, dir := newManager(t)
	// Manager.Start's format, and the shell script's.
	writePcap(t, dir, "2026-08-10-141223-sensor-capture.pcap")
	writePcap(t, dir, "20260810-141223-dji-first-flight.pcap")

	if _, err := m.AdoptOrphans(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := m.store.ListCaptures(context.Background())
	if len(got) != 2 {
		t.Fatalf("adopted %d, want 2", len(got))
	}
	for _, c := range got {
		if c.StartedAt.Year() != 2026 || c.StartedAt.Hour() != 14 {
			t.Fatalf("%s: bad timestamp %s", c.Filename, c.StartedAt)
		}
	}
}

func TestUnparseableNameFallsBackToModTime(t *testing.T) {
	m, dir := newManager(t)
	writePcap(t, dir, "something-arbitrary.pcap")

	if _, err := m.AdoptOrphans(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := m.store.ListCaptures(context.Background())
	if len(got) != 1 {
		t.Fatalf("adopted %d, want 1", len(got))
	}
	if got[0].StartedAt.IsZero() {
		t.Fatal("StartedAt must fall back to the file's modification time")
	}
	if got[0].Label != "something-arbitrary" {
		t.Fatalf("label = %q", got[0].Label)
	}
}

func TestNonPcapFilesIgnored(t *testing.T) {
	m, dir := newManager(t)
	writePcap(t, dir, "real.pcap")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("notes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	n, err := m.AdoptOrphans(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("adopted %d, want 1 -- captures/README.md is committed and must be ignored", n)
	}
}

func TestMissingDirectoryIsNotAnError(t *testing.T) {
	m := NewManager(memstore.New(), Options{Dir: filepath.Join(t.TempDir(), "absent")})
	n, err := m.AdoptOrphans(context.Background())
	if err != nil {
		t.Fatalf("a missing capture directory must not fail startup: %v", err)
	}
	if n != 0 {
		t.Fatalf("adopted %d", n)
	}
}

func TestRepairsZeroFrameCount(t *testing.T) {
	// A record written before frame counting worked reports 0 frames for a good
	// capture. Idempotency alone would leave that wrong forever.
	m, dir := newManager(t)
	ctx := context.Background()

	writePcap(t, dir, "20260810-141223-dji-first-flight.pcap")
	if _, err := m.AdoptOrphans(ctx); err != nil {
		t.Fatal(err)
	}

	// Replace the file with one that has real packets, as if counting had been
	// broken when the record was first written.
	full := buildPcap(binary.LittleEndian, magicMicroLE, 779, 20)
	if err := os.WriteFile(filepath.Join(dir, "20260810-141223-dji-first-flight.pcap"), full, 0o600); err != nil {
		t.Fatal(err)
	}

	n, err := m.AdoptOrphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("repaired %d, want 1", n)
	}
	got, _ := m.store.ListCaptures(ctx)
	if len(got) != 1 {
		t.Fatalf("repair duplicated the record: %d", len(got))
	}
	if got[0].FrameCount != 779 {
		t.Fatalf("FrameCount = %d, want 779", got[0].FrameCount)
	}
}

func TestRepairDoesNotOverwriteAGoodCount(t *testing.T) {
	m, dir := newManager(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(dir, "c.pcap"),
		buildPcap(binary.LittleEndian, magicMicroLE, 5, 10), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.AdoptOrphans(ctx); err != nil {
		t.Fatal(err)
	}
	n, err := m.AdoptOrphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("a record with a good count must be left alone, changed %d", n)
	}
}

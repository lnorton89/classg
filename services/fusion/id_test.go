package fusion

import "testing"

func TestNewTrackID(t *testing.T) {
	a, b := NewTrackID(), NewTrackID()
	if len(a) != 26 || len(b) != 26 {
		t.Fatalf("ULID lengths: %d, %d", len(a), len(b))
	}
	if a == b {
		t.Fatal("successive track IDs must differ")
	}
}

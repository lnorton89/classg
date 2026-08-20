package ulid

import (
	"sort"
	"strings"
	"testing"
	"time"
)

// This package had no tests, and the one property everything else leans on --
// "identifiers sort by creation time, which makes keyset pagination over them
// stable" -- was asserted nowhere. A generator that lost that would not fail
// loudly: pages would skip rows or repeat them, which reads as a quiet sky.

func TestSortsByCreationTime(t *testing.T) {
	base := time.Date(2026, 8, 11, 14, 0, 0, 0, time.UTC)
	// Adjacent milliseconds, because a page boundary lands between two records
	// far more often than a second apart.
	var ids []string
	for i := 0; i < 200; i++ {
		ids = append(ids, New(base.Add(time.Duration(i)*time.Millisecond)))
	}

	for i := 1; i < len(ids); i++ {
		if ids[i] <= ids[i-1] {
			t.Fatalf("id for +%dms (%s) does not sort after +%dms (%s)",
				i, ids[i], i-1, ids[i-1])
		}
	}

	// And the ordering survives a shuffle-and-sort, which is what the database
	// actually does with them.
	shuffled := append([]string(nil), ids...)
	for i := range shuffled {
		j := (i * 7919) % len(shuffled) // deterministic, no rand in a test
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	}
	sort.Strings(shuffled)
	for i := range ids {
		if shuffled[i] != ids[i] {
			t.Fatalf("byte order does not recover creation order at %d", i)
		}
	}
}

// The timestamp is the first ten characters and nothing else may reach them.
// A second's worth of ids sharing a prefix is what makes a cursor comparable.
func TestTheTimestampPrefixIsStableWithinAMillisecond(t *testing.T) {
	at := time.Date(2026, 8, 11, 14, 0, 0, 0, time.UTC)
	first := New(at)
	for i := 0; i < 50; i++ {
		got := New(at)
		if got[:10] != first[:10] {
			t.Fatalf("same instant produced prefixes %s and %s", first[:10], got[:10])
		}
		if got == first {
			t.Fatal("two ids at the same instant were identical; the entropy is not entropy")
		}
	}
}

func TestShapeIsTheSchemaShape(t *testing.T) {
	// schemas/detection.schema.json's example is a 26-character Crockford
	// string, and the store's cursor splits on it. Anything else is a wire
	// change, not a refactor.
	for _, id := range []string{New(time.Now()), Now(), New(time.Unix(0, 0))} {
		if len(id) != 26 {
			t.Errorf("%q is %d characters, want 26", id, len(id))
		}
		for i, c := range id {
			if !strings.ContainsRune(crockford, c) {
				t.Errorf("%q has %q at %d, which is not in the Crockford alphabet", id, c, i)
			}
		}
	}
}

// Crockford base32 excludes I, L, O and U: the first three because they are
// confusable with 1 and 0 when read off a screen, U because it makes accidental
// words. An alphabet that grew one of them back would still encode, and would
// stop matching every other ULID implementation.
func TestAlphabetIsCrockford(t *testing.T) {
	if len(crockford) != 32 {
		t.Fatalf("alphabet is %d characters", len(crockford))
	}
	for _, c := range "ILOU" {
		if strings.ContainsRune(crockford, c) {
			t.Errorf("%q is in the alphabet; Crockford base32 excludes it", c)
		}
	}
	seen := map[rune]bool{}
	for _, c := range crockford {
		if seen[c] {
			t.Errorf("%q appears twice", c)
		}
		seen[c] = true
	}
	// Ordered, or byte order stops matching value order and the sort property
	// above holds only by luck.
	if !sort.StringsAreSorted(strings.Split(crockford, "")) {
		t.Error("the alphabet is not in ascending byte order")
	}
}

// Every one of the 80 entropy bits has to reach the string. A generator that
// dropped the last few would still look random and would collide far sooner
// than the birthday bound anyone reasoned about.
func TestEntropyFillsTheWholeSuffix(t *testing.T) {
	at := time.Date(2026, 8, 11, 14, 0, 0, 0, time.UTC)
	// Per position, count how many distinct characters appear across many ids.
	// A position that never varies is a position carrying no entropy.
	distinct := make([]map[byte]bool, 26)
	for i := range distinct {
		distinct[i] = map[byte]bool{}
	}
	const runs = 400
	for i := 0; i < runs; i++ {
		id := New(at)
		for p := 0; p < 26; p++ {
			distinct[p][id[p]] = true
		}
	}
	for p := 10; p < 26; p++ {
		if len(distinct[p]) < 8 {
			t.Errorf("position %d took only %d distinct values across %d ids; "+
				"that part of the suffix is not carrying entropy", p, len(distinct[p]), runs)
		}
	}
	// And the timestamp half must NOT vary at a fixed instant.
	for p := 0; p < 10; p++ {
		if len(distinct[p]) != 1 {
			t.Errorf("timestamp position %d varied at a fixed instant", p)
		}
	}
}

// A zero time.Time is an uninitialised struct field, which is the easiest
// mistake in Go, and before the clamp it produced an id beginning ZZZZZ:
// negative UnixMilli wrapped through uint64. One such row sits at the end of
// every keyset page for ever, and nothing about it looks wrong.
func TestATimeBeforeTheEpochSortsFirst(t *testing.T) {
	real := New(time.Date(2026, 8, 11, 14, 0, 0, 0, time.UTC))

	for _, early := range []time.Time{
		{}, // the zero value, the one a caller will actually pass
		time.Unix(0, 0).Add(-time.Hour),
		time.Date(1969, 7, 20, 20, 17, 0, 0, time.UTC),
	} {
		id := New(early)
		if len(id) != 26 {
			t.Errorf("%v produced %q", early, id)
			continue
		}
		if id >= real {
			t.Errorf("%v produced %q, which sorts at or after a present-day %q -- "+
				"one row like this ends every keyset page", early, id, real)
		}
	}
}

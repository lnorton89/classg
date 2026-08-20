package store

import (
	"encoding/base64"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/classg/api/internal/ulid"
)

// Cursor is why paging over a table that is being appended to does not skip
// rows -- "an OFFSET page walk over a table that is being appended to silently
// skips rows", as the type's own comment puts it. Nothing tested it. The
// tie-break in Before is one character away from being backwards, and a
// backwards one does not error: it just serves a page that quietly omits every
// detection sharing a timestamp with the last row of the previous page.

func TestCursorRoundTrips(t *testing.T) {
	for _, c := range []Cursor{
		{TS: time.Date(2026, 8, 11, 14, 23, 11, 482_000_000, time.UTC), ID: "01J8XQ0000000000000000000A"},
		// Whole seconds: RFC3339Nano drops trailing zeros, so this and the
		// nanosecond case take different paths through the formatter.
		{TS: time.Date(2026, 8, 11, 14, 23, 11, 0, time.UTC), ID: "01J8XQ0000000000000000000A"},
		{TS: time.Date(2026, 8, 11, 14, 23, 11, 1, time.UTC), ID: "01J8XQ0000000000000000000A"},
		// A non-UTC input must come back as the same instant in UTC, or the
		// comparison against stored UTC timestamps is off by the offset.
		{TS: time.Date(2026, 8, 11, 7, 23, 11, 0, time.FixedZone("PDT", -7*3600)), ID: "X"},
	} {
		got, err := DecodeCursor(c.Encode())
		if err != nil {
			t.Fatalf("%v: %v", c, err)
		}
		if !got.TS.Equal(c.TS) {
			t.Errorf("ts round-tripped %v as %v", c.TS, got.TS)
		}
		if got.ID != c.ID {
			t.Errorf("id round-tripped %q as %q", c.ID, got.ID)
		}
		if got.TS.Location() != time.UTC {
			t.Errorf("decoded cursor is in %v, not UTC", got.TS.Location())
		}
	}
}

// A cursor is client-supplied, so every malformed shape has to be an error
// rather than a zero Cursor -- which would silently restart paging from the
// beginning of time and repeat the whole table.
func TestAMalformedCursorIsRefused(t *testing.T) {
	for name, s := range map[string]string{
		"empty":            "",
		"not base64":       "!!!!",
		"base64 of junk":   "aGVsbG8", // "hello": no NUL separator
		"no separator":     encodeRaw("2026-08-11T14:23:11Z"),
		"unparseable time": encodeRaw("not-a-time\x00abc"),
		"empty time":       encodeRaw("\x00abc"),
	} {
		if _, err := DecodeCursor(s); err == nil {
			t.Errorf("%s: %q decoded without error", name, s)
		}
	}
}

// Truncating a cursor is NOT malformed, and it was worth finding that out
// rather than assuming: lopping characters off the end shortens the id, and a
// shorter id is a perfectly good position. The result is a page boundary a row
// or two from where the client meant, in that client's own walk, and nothing
// worse -- a cursor names a position, it does not grant anything. Recorded so
// the next person does not "fix" it into an error.
func TestATruncatedCursorIsAPositionNotAnError(t *testing.T) {
	const id = "01J8XQ0000000000000000000A"
	full := Cursor{TS: time.Date(2026, 8, 11, 14, 23, 11, 0, time.UTC), ID: id}.Encode()

	got, err := DecodeCursor(full[:len(full)-4])
	if err != nil {
		t.Fatalf("a truncated cursor errored: %v", err)
	}
	if got.ID == id {
		t.Fatal("truncation did not change the id; this test proves nothing")
	}
	if !strings.HasPrefix(id, got.ID) {
		t.Errorf("truncation produced %q, which is not a prefix of %q", got.ID, id)
	}
}

// encodeRaw builds a cursor body by hand, to test shapes Encode cannot make.
func encodeRaw(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

// Before decides which side of the page boundary a row falls on, in a
// (timestamp DESC, id DESC) ordering.
func TestBeforePlacesRowsOnTheRightSideOfTheBoundary(t *testing.T) {
	at := time.Date(2026, 8, 11, 14, 23, 11, 0, time.UTC)
	c := Cursor{TS: at, ID: "M"}

	cases := []struct {
		name string
		ts   time.Time
		id   string
		want bool
	}{
		{"newer timestamp is on an earlier page", at.Add(time.Second), "A", false},
		{"older timestamp is on a later page", at.Add(-time.Second), "Z", true},
		{"same timestamp, smaller id, is on a later page", at, "A", true},
		{"same timestamp, larger id, is on an earlier page", at, "Z", false},
		// The row the cursor names must not come back, or every page repeats
		// its predecessor's last row.
		{"the cursor's own row is excluded", at, "M", false},
	}
	for _, tc := range cases {
		if got := c.Before(tc.ts, tc.id); got != tc.want {
			t.Errorf("%s: Before(%v, %q) = %v, want %v", tc.name, tc.ts, tc.id, got, tc.want)
		}
	}
}

// The property all of it exists for: walking a page at a time visits every row
// exactly once. Deliberately built with many rows sharing a timestamp, because
// that is the only case where the id tie-break does any work -- and detections
// from two sensors in the same millisecond are the ordinary case here, not a
// contrived one.
func TestPagingVisitsEveryRowExactlyOnce(t *testing.T) {
	type row struct {
		ts time.Time
		id string
	}
	base := time.Date(2026, 8, 11, 14, 0, 0, 0, time.UTC)

	var rows []row
	for tick := 0; tick < 40; tick++ {
		ts := base.Add(time.Duration(tick) * time.Millisecond)
		// Three rows per instant, ids minted the way the service mints them.
		for i := 0; i < 3; i++ {
			rows = append(rows, row{ts: ts, id: ulid.New(ts)})
		}
	}
	// (timestamp DESC, id DESC), which is what the store orders by.
	sort.Slice(rows, func(i, j int) bool {
		if !rows[i].ts.Equal(rows[j].ts) {
			return rows[i].ts.After(rows[j].ts)
		}
		return rows[i].id > rows[j].id
	})

	const pageSize = 7
	seen := map[string]int{}
	var cursor *Cursor
	pages := 0

	for {
		var page []row
		for _, r := range rows {
			if cursor != nil && !cursor.Before(r.ts, r.id) {
				continue
			}
			page = append(page, r)
			if len(page) == pageSize {
				break
			}
		}
		if len(page) == 0 {
			break
		}
		pages++
		if pages > len(rows) {
			t.Fatal("paging did not terminate")
		}
		for _, r := range page {
			seen[r.id]++
		}
		last := page[len(page)-1]
		// Re-encoded every time, because that is what a client sends back.
		next, err := DecodeCursor(Cursor{TS: last.ts, ID: last.id}.Encode())
		if err != nil {
			t.Fatal(err)
		}
		cursor = &next
	}

	if len(seen) != len(rows) {
		t.Errorf("paging visited %d of %d rows", len(seen), len(rows))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s was served %d times", id, n)
		}
	}
	for _, r := range rows {
		if seen[r.id] == 0 {
			t.Errorf("%s (%v) was never served", r.id, r.ts)
		}
	}
}

// The encoding is opaque to clients but must stay stable: a cursor handed out
// before a deploy is handed back after one.
func TestTheEncodingIsUrlSafeAndUnpadded(t *testing.T) {
	s := Cursor{
		TS: time.Date(2026, 8, 11, 14, 23, 11, 482_000_000, time.UTC),
		ID: "01J8XQ0000000000000000000A",
	}.Encode()

	if strings.ContainsAny(s, "+/=") {
		t.Errorf("cursor %q contains characters that need escaping in a query string", s)
	}
}

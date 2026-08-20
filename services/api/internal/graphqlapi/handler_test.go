package graphqlapi

import (
	"strings"
	"testing"

	"github.com/graphql-go/graphql/language/ast"
	"github.com/graphql-go/graphql/language/parser"
	"github.com/graphql-go/graphql/language/source"
)

// checkCost is the whole defence on this endpoint and it had no test at all.
//
// It is not a validity check -- the executor does that. It is a budget for a
// Pi 4 that is decoding Wi-Fi frames on a deadline while it answers, against a
// query authenticated at the LOWEST role the API has. Every limit here exists
// because the shape it refuses was cheap to type and expensive to serve.

func costErr(t *testing.T, query string, variables map[string]any) string {
	t.Helper()
	err := checkCost(query, variables)
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestCostAllowsTheQueriesThisEndpointExistsFor(t *testing.T) {
	// The stated purpose: tracks and, for each, the detections that fed it, in
	// one round trip. If the limiter refuses this, it is refusing the feature.
	ok := []string{
		`{ tracks { tracks { track_id confidence } } }`,
		`{ tracks(limit: 100) { tracks { track_id detections { detection_id } } } }`,
		`query T($n: Int) { tracks(limit: $n) { tracks { detections { rssi_dbm } } } }`,
		`{ tracks { tracks { ... on Track { detections { detection_id } } } } }`,
		`{ t: tracks { total } d: tracks { total } }`,
		// A fragment used twice in different places is entered both times; only
		// a repeat on the same path is refused.
		`{ a: tracks { tracks { ...f } } b: tracks { tracks { ...f } } }
		 fragment f on Track { track_id }`,
	}
	for _, q := range ok {
		if msg := costErr(t, q, map[string]any{"n": 100}); msg != "" {
			t.Errorf("refused a query this endpoint exists to answer:\n  %s\n  %s", q, msg)
		}
	}
}

// The fan-out budget was steppable in two lines. selectionSubtreeHas stopped
// at a named spread, so moving `detections` into a fragment hid it: the
// thousand-parent page went through, and each parent runs its own store query
// on the single connection.
func TestFanOutBudgetSurvivesANamedFragment(t *testing.T) {
	inline := `{ tracks(limit: 1000) { tracks { detections { detection_id } } } }`
	if msg := costErr(t, inline, nil); msg == "" {
		t.Fatal("a thousand-track page with detections inline was allowed")
	}

	hidden := `{ tracks(limit: 1000) { tracks { ...d } } }
	            fragment d on Track { detections { detection_id } }`
	msg := costErr(t, hidden, nil)
	if msg == "" {
		t.Fatal("the same fan-out was allowed once detections moved into a fragment")
	}
	if !strings.Contains(msg, "1000") {
		t.Errorf("the refusal did not name the page asked for: %s", msg)
	}

	// Nested one more level, because a fragment may spread a fragment.
	deeper := `{ tracks(limit: 500) { tracks { ...a } } }
	           fragment a on Track { ...b }
	           fragment b on Track { detections { detection_id } }`
	if costErr(t, deeper, nil) == "" {
		t.Error("fan-out hidden two fragments deep was allowed")
	}

	// Via a variable, which is how a real client would send it.
	byVar := `query T($n: Int) { tracks(limit: $n) { tracks { ...d } } }
	          fragment d on Track { detections { detection_id } }`
	if costErr(t, byVar, map[string]any{"n": float64(1000)}) == "" {
		t.Error("fan-out through a variable limit was allowed")
	}
}

func TestDepthAndWidthSurviveANamedFragment(t *testing.T) {
	// Depth is bounded by the schema having no cycle, so this is headroom
	// rather than a working limit -- but the walker must still see through a
	// spread, or the ceiling is not there the day a back-reference is added.
	deep := `{ ...l1 }
	         fragment l1 on Query { tracks { tracks { detections { ...l2 } } } }
	         fragment l2 on Detection { position { ...l3 } }
	         fragment l3 on Position { ... on Position { at } }`
	if d := countDepth(t, deep); d < 5 {
		t.Errorf("depth through fragments counted %d; the query nests further than that", d)
	}

	var wide strings.Builder
	wide.WriteString("{ ...w }\nfragment w on Query {")
	for i := 0; i < MaxAliases+1; i++ {
		wide.WriteString(" a")
		wide.WriteString(string(rune('A' + i%26)))
		wide.WriteString(string(rune('a' + i/26)))
		wide.WriteString(": tracks { total }")
	}
	wide.WriteString(" }")
	if msg := costErr(t, wide.String(), nil); msg == "" {
		t.Error("a fragment wider than MaxAliases was allowed")
	}
}

// countDepth reaches the walker directly: checkCost only reports a breach, and
// what matters here is that a spread is not counted as a leaf.
func countDepth(t *testing.T, query string) int {
	t.Helper()
	doc, err := parser.Parse(parser.ParseParams{
		Source: source.NewSource(&source.Source{Body: []byte(query), Name: "GraphQL"}),
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	frags := map[string]*ast.FragmentDefinition{}
	for _, def := range doc.Definitions {
		if f, ok := def.(*ast.FragmentDefinition); ok && f.Name != nil {
			frags[f.Name.Value] = f
		}
	}
	for _, def := range doc.Definitions {
		if op, ok := def.(*ast.OperationDefinition); ok && op.SelectionSet != nil {
			return depth(op.SelectionSet, 1, frags, map[string]bool{})
		}
	}
	t.Fatal("no operation in the document")
	return 0
}

// A cyclic fragment pair is an invalid document, and validation would reject
// it -- but validation runs inside graphql.Do, and checkCost runs BEFORE that.
// Without a guard on the path, these walkers recurse until the stack ends and
// the process with it. Reaching the end of this test at all is the assertion.
func TestCyclicFragmentsDoNotRecurseForever(t *testing.T) {
	cyclic := []string{
		`{ ...a } fragment a on Query { ...b } fragment b on Query { ...a }`,
		`{ ...a } fragment a on Query { ...a }`,
		`{ tracks { tracks { ...a } } } fragment a on Track { ...b } fragment b on Track { ...a }`,
		// Unknown spread: nothing to enter, and it must not panic either.
		`{ tracks { tracks { ...nosuch } } }`,
	}
	for _, q := range cyclic {
		_ = checkCost(q, nil)
	}
}

// A document that does not parse is passed through deliberately, so the
// executor reports the real error with its position rather than the cost check
// reporting a worse one first.
func TestAnUnparseableDocumentIsLeftToTheExecutor(t *testing.T) {
	if err := checkCost("{ this is not graphql", nil); err != nil {
		t.Errorf("a parse error was reported by the cost check instead of the executor: %v", err)
	}
}

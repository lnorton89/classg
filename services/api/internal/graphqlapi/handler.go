package graphqlapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/graphql-go/graphql"
	"github.com/graphql-go/graphql/gqlerrors"
	"github.com/graphql-go/graphql/language/ast"
	"github.com/graphql-go/graphql/language/parser"
	"github.com/graphql-go/graphql/language/source"

	"github.com/classg/api/internal/apierr"
)

// MaxQueryBytes bounds the document itself. A query long enough to matter here
// is a query nobody wrote by hand.
const MaxQueryBytes = 64 << 10

// MaxDepth is the deepest selection this endpoint will execute.
//
// GraphQL's usual denial-of-service shape is a query that walks a cycle --
// track -> detections -> track -> detections -- until the resolver count is
// exponential. This schema has no cycle today: Detection carries no reference
// back to a Track, so the deepest path that exists is six
// (tracks -> tracks -> detections -> detections -> position -> at) and depth
// is bounded by construction rather than by this constant.
//
// Eight is therefore headroom, not a working limit, and it exists so that the
// day somebody adds the back-reference -- which is the natural thing to want
// -- the ceiling is already there. On a Pi 4 that matters: the same box is
// decoding Wi-Fi frames on a deadline while this runs.
const MaxDepth = 8

// MaxAliases bounds repeated top-level fields. Depth alone does not stop
// `{a: tracks{...} b: tracks{...} c: tracks{...}}` -- that is a flat query
// that runs the expensive resolver as many times as the client can type.
const MaxAliases = 24

// Handler serves GraphQL over HTTP.
//
// POST with a JSON body is the whole surface. GET is deliberately not
// accepted: a GET carrying a query is cacheable and loggable by anything in
// the path, and detections carry positions. There is no GraphiQL either --
// this is a Pi serving its own operator, and shipping an IDE would mean
// shipping a bundle to a box that has no room for one. Introspection is left
// enabled, so a client author can generate types against the live schema.
func Handler(deps Deps) (http.HandlerFunc, error) {
	schema, err := Schema(deps)
	if err != nil {
		return nil, err
	}
	r := &resolvers{deps: deps}

	return func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			apierr.Write(w, apierr.NotFound(
				"GraphQL is POST-only; a query in a URL would be cached and logged by everything in the path"))
			return
		}
		if ct := req.Header.Get("Content-Type"); ct != "" &&
			!strings.HasPrefix(ct, "application/json") {
			apierr.Write(w, apierr.InvalidParameter("Content-Type",
				"GraphQL requests must be application/json"))
			return
		}

		body, err := io.ReadAll(io.LimitReader(req.Body, MaxQueryBytes+1))
		if err != nil {
			apierr.Write(w, apierr.InvalidParameter("body", "could not read the request body"))
			return
		}
		if len(body) > MaxQueryBytes {
			apierr.Write(w, apierr.InvalidParameter("query",
				"the query document is larger than this unit will parse"))
			return
		}

		var in struct {
			Query         string         `json:"query"`
			OperationName string         `json:"operationName"`
			Variables     map[string]any `json:"variables"`
		}
		if err := json.Unmarshal(body, &in); err != nil {
			apierr.Write(w, apierr.InvalidParameter("body", "the request body is not JSON"))
			return
		}
		if strings.TrimSpace(in.Query) == "" {
			apierr.Write(w, apierr.InvalidParameter("query", "no query was supplied"))
			return
		}

		// Cost is checked before execution rather than during it. A limit
		// enforced by a resolver has already paid for every resolver that ran
		// before it, which on this hardware is the cost that mattered.
		if err := checkCost(in.Query); err != nil {
			writeGraphQLError(w, err.Error())
			return
		}

		result := graphql.Do(graphql.Params{
			Schema:         schema,
			RequestString:  in.Query,
			VariableValues: in.Variables,
			OperationName:  in.OperationName,
			Context:        withResolvers(req.Context(), r),
		})

		// Always 200, even with errors in the body. That is the GraphQL
		// contract and not an oversight: a partial result with an errors array
		// is a normal outcome, and a client library expects to find it there
		// rather than in this API's REST error envelope. The envelope is still
		// used for everything that fails BEFORE a query is executed, which are
		// transport failures rather than query failures.
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(result)
	}, nil
}

func writeGraphQLError(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(&graphql.Result{
		Errors: []gqlerrors.FormattedError{{Message: msg}},
	})
}

// checkCost walks the parsed document and refuses queries that are too deep or
// too wide before any resolver runs.
func checkCost(query string) error {
	doc, err := parser.Parse(parser.ParseParams{
		Source: source.NewSource(&source.Source{Body: []byte(query), Name: "GraphQL"}),
	})
	if err != nil {
		// Let the executor produce the real parse error, with its position,
		// rather than reporting it twice in two different shapes.
		return nil
	}

	for _, def := range doc.Definitions {
		op, ok := def.(*ast.OperationDefinition)
		if !ok || op.SelectionSet == nil {
			continue
		}
		if n := len(op.SelectionSet.Selections); n > MaxAliases {
			return errors.New("this query asks for " + strconv.Itoa(n) +
				" top-level fields; this unit executes at most " + strconv.Itoa(MaxAliases))
		}
		if d := depth(op.SelectionSet, 1); d > MaxDepth {
			return errors.New("this query is " + strconv.Itoa(d) +
				" levels deep; this unit executes at most " + strconv.Itoa(MaxDepth) +
				". Ask for what you need in two queries rather than one walk of the graph")
		}
	}
	return nil
}

// depth counts field nesting. An inline fragment is not a level of its own --
// `... on Track { detections }` selects at the same depth the fragment sits at
// -- so it recurses without incrementing.
//
// Named fragments are not followed: a spread is counted as a leaf, which
// under-counts a query that hides depth in one. That is a known gap and it is
// bounded, because fragment cycles are illegal and rejected by validation, so
// the worst case is a fixed multiple of MaxDepth rather than an unbounded walk.
func depth(set *ast.SelectionSet, at int) int {
	deepest := at
	for _, sel := range set.Selections {
		var d int
		switch s := sel.(type) {
		case *ast.Field:
			if s.SelectionSet == nil {
				continue
			}
			d = depth(s.SelectionSet, at+1)
		case *ast.InlineFragment:
			if s.SelectionSet == nil {
				continue
			}
			d = depth(s.SelectionSet, at)
		default:
			continue
		}
		if d > deepest {
			deepest = d
		}
	}
	return deepest
}

package apierr

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Every non-2xx response in the service goes through this package, and none of
// it had a test. The mapping is the part clients branch on: a code that arrives
// with the wrong status is a client bug that looks like a server bug, and the
// 401/403 split in particular decides whether a working session gets thrown
// away -- "a viewer clicking an admin link gets bounced out of a session that
// is working perfectly", as the constant's own comment puts it.

func TestEveryCodeMapsToItsContractStatus(t *testing.T) {
	cases := []struct {
		err  *Error
		code string
		want int
	}{
		{InvalidParameter("limit", "must be an integer"), CodeInvalidParameter, http.StatusBadRequest},
		{NotFound("no track with id X"), CodeNotFound, http.StatusNotFound},
		{Conflict("a capture is already running"), CodeConflict, http.StatusConflict},
		// Both 503 deliberately: the resource exists, the machine cannot serve
		// it, and a retry after operator intervention is the right response.
		{PrivilegesRequired("capture needs root"), CodePrivilegesRequired, http.StatusServiceUnavailable},
		{SensorUnavailable("no SDR is attached"), CodeSensorUnavailable, http.StatusServiceUnavailable},
		{Unauthenticated("log in to continue"), CodeUnauthenticated, http.StatusUnauthorized},
		{Forbidden("this needs the admin role"), CodeForbidden, http.StatusForbidden},
		// 409, not 401: nothing is wrong with the caller's credentials.
		{SetupRequired("this unit has no accounts yet"), CodeSetupRequired, http.StatusConflict},
		{Internal("saving failed"), CodeInternal, http.StatusInternalServerError},
	}

	for _, tc := range cases {
		if tc.err.Code != tc.code {
			t.Errorf("constructor produced code %q, want %q", tc.err.Code, tc.code)
		}
		if got := tc.err.Status(); got != tc.want {
			t.Errorf("%s maps to %d, want %d", tc.code, got, tc.want)
		}
	}
}

// An unknown code must not become a 200. A constant added without a Status
// arm would otherwise serve an error body under a success status, which is the
// one shape no client checks for.
func TestAnUnknownCodeIsAServerError(t *testing.T) {
	e := &Error{Code: "something_new", Message: "hello"}
	if got := e.Status(); got != http.StatusInternalServerError {
		t.Errorf("an unmapped code produced %d, want 500", got)
	}
}

func TestTheEnvelopeIsTheContractShape(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, InvalidParameter("limit", "limit must be <= 1000"))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type is %q", ct)
	}

	// Decoded into a map, not the envelope struct: what matters is the exact
	// set of keys on the wire, and decoding into the type it was encoded from
	// would not notice an extra one.
	var body map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%v: %s", err, w.Body.String())
	}
	if len(body) != 1 || body["error"] == nil {
		t.Fatalf("the envelope is not {error: ...}: %s", w.Body.String())
	}
	got := body["error"]
	for k, want := range map[string]any{
		"code":    CodeInvalidParameter,
		"message": "limit must be <= 1000",
		"field":   "limit",
	} {
		if got[k] != want {
			t.Errorf("error.%s = %v, want %v", k, got[k], want)
		}
	}
	// status is deliberately not serialised.
	if _, ok := got["status"]; ok {
		t.Error("the envelope carries an internal status field")
	}
	if len(got) != 3 {
		t.Errorf("the envelope has %d fields: %v", len(got), got)
	}
}

// field is omitted rather than sent empty, so a client can tell "this is about
// a specific parameter" from "this is about the request".
func TestFieldIsAbsentWhenThereIsNoField(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, NotFound("no capture with id X"))

	var body map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["error"]["field"]; ok {
		t.Errorf("field was serialised on an error that has none: %s", w.Body.String())
	}
}

// A wrapped *Error must keep its code. Nothing wraps one today, and
// fmt.Errorf("...: %w", NotFound(...)) is the obvious way somebody will add
// context tomorrow -- under a bare type assertion that 404 became a 500 with
// the message thrown away.
func TestAWrappedErrorKeepsItsCode(t *testing.T) {
	wrapped := fmt.Errorf("loading the track failed: %w", NotFound("no track with id X"))

	w := httptest.NewRecorder()
	Write(w, wrapped)

	if w.Code != http.StatusNotFound {
		t.Fatalf("a wrapped not_found produced %d, want 404: %s", w.Code, w.Body.String())
	}
	var body map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"]["code"] != CodeNotFound {
		t.Errorf("code is %v", body["error"]["code"])
	}
}

// Anything else still gets a well-formed envelope. A 500 with no body forces
// every client to special-case it, and they get that wrong.
func TestAnUnrecognisedErrorStillGetsAnEnvelope(t *testing.T) {
	for name, err := range map[string]error{
		"plain":         errors.New("the database is on fire"),
		"nil":           nil,
		"typed nil":     (*Error)(nil),
		"wrapped plain": fmt.Errorf("context: %w", errors.New("boom")),
		"not an apierr": &notAnAPIError{},
	} {
		w := httptest.NewRecorder()
		Write(w, err)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s: status %d, want 500", name, w.Code)
		}
		var body map[string]map[string]any
		if jsonErr := json.Unmarshal(w.Body.Bytes(), &body); jsonErr != nil {
			t.Errorf("%s: body is not the envelope: %s", name, w.Body.String())
			continue
		}
		if body["error"]["code"] != CodeInternal {
			t.Errorf("%s: code is %v, want %q", name, body["error"]["code"], CodeInternal)
		}
		// And never the internal detail. This is the boundary where a database
		// error stops being the client's business.
		if msg, _ := body["error"]["message"].(string); msg != "unexpected server error" {
			t.Errorf("%s: message is %q; an internal error's text must not reach a client", name, msg)
		}
	}
}

type notAnAPIError struct{}

func (*notAnAPIError) Error() string { return "not one of ours" }

// Error() is what appears in a log line, so it has to carry both halves.
func TestErrorStringNamesTheCodeAndTheMessage(t *testing.T) {
	got := NotFound("no track with id X").Error()
	if got != "not_found: no track with id X" {
		t.Errorf("Error() = %q", got)
	}
}

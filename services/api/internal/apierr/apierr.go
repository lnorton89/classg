// Package apierr implements the single error envelope from
// docs/architecture/api-contract.md#errors.
//
// Every non-2xx response in the service goes through here. Clients parse one
// shape, so a 404 from a typo'd path and a 400 from a bad limit are handled by
// the same branch of client code -- which is the point of specifying it.
package apierr

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// The closed set from the contract. Adding a code is a contract change, not an
// implementation detail, so they are constants rather than free strings.
const (
	CodeInvalidParameter   = "invalid_parameter"
	CodeNotFound           = "not_found"
	CodeConflict           = "conflict"
	CodePrivilegesRequired = "privileges_required"
	CodeSensorUnavailable  = "sensor_unavailable"
	CodeInternal           = "internal"
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`

	// status is not serialised: the envelope on the wire carries only the
	// contract's three fields.
	status int
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Status is the HTTP status this error maps to.
//
// privileges_required and sensor_unavailable both map to 503 deliberately: from
// a caller's perspective the resource exists but the machine cannot currently
// serve it, and a retry after operator intervention is the right response.
func (e *Error) Status() int {
	if e.status != 0 {
		return e.status
	}
	switch e.Code {
	case CodeInvalidParameter:
		return http.StatusBadRequest
	case CodeNotFound:
		return http.StatusNotFound
	case CodeConflict:
		return http.StatusConflict
	case CodePrivilegesRequired, CodeSensorUnavailable:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

type envelope struct {
	Error Error `json:"error"`
}

func InvalidParameter(field, message string) *Error {
	return &Error{Code: CodeInvalidParameter, Message: message, Field: field}
}

func NotFound(message string) *Error {
	return &Error{Code: CodeNotFound, Message: message}
}

func Conflict(message string) *Error {
	return &Error{Code: CodeConflict, Message: message}
}

func PrivilegesRequired(message string) *Error {
	return &Error{Code: CodePrivilegesRequired, Message: message}
}

func SensorUnavailable(message string) *Error {
	return &Error{Code: CodeSensorUnavailable, Message: message}
}

func Internal(message string) *Error {
	return &Error{Code: CodeInternal, Message: message}
}

// Write emits err as the contract envelope. A nil or unrecognised error becomes
// `internal` rather than an empty body, because a client that receives 500 with
// no envelope has to special-case it and will get that wrong.
func Write(w http.ResponseWriter, err error) {
	e, ok := err.(*Error)
	if !ok || e == nil {
		e = Internal("unexpected server error")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(e.Status())
	if encErr := json.NewEncoder(w).Encode(envelope{Error: *e}); encErr != nil {
		slog.Error("writing error envelope failed", "err", encErr)
	}
}

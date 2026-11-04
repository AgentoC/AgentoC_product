package main

import (
	"context"
	"regexp"
	"strings"
	"unicode"
)

// The native backend must open the exact service once, verify its identity and
// protected definition on that handle, and keep it open for the whole action.
// Start and Stop must wait for the requested state and return an error when
// the outcome cannot be confirmed. A request never supplies an executable,
// command line, shell, or open handle.
type serviceControlTarget interface {
	Fingerprint() (string, error)
	Start(context.Context) error
	Stop(context.Context) error
	Close() error
}

type serviceControlRequest struct {
	Name           string
	Action         string
	DefinitionHash string
}

type serviceControlOutcome struct {
	Status requestStatus
	Code   string
}

var serviceDefinitionHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validServiceControlName(name string) bool {
	if name == "" || strings.TrimSpace(name) != name || len([]rune(name)) > 256 || strings.ContainsAny(name, `\/*?`) {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// The returned state distinguishes a refused operation from an uncertain or
// partially completed one. An accepted stop/start must never be blindly retried.
func runServiceControl(ctx context.Context, request serviceControlRequest, open func(string) (serviceControlTarget, error)) serviceControlOutcome {
	failed := func(code string) serviceControlOutcome {
		return serviceControlOutcome{Status: statusFailed, Code: code}
	}
	unknown := func(code string) serviceControlOutcome {
		return serviceControlOutcome{Status: statusUnknown, Code: code}
	}
	if !validServiceControlName(request.Name) || !serviceDefinitionHash.MatchString(request.DefinitionHash) ||
		(request.Action != "start-service" && request.Action != "stop-service" && request.Action != "restart-service") || open == nil {
		return failed("SERVICE_REQUEST_INVALID")
	}
	if ctx == nil || ctx.Err() != nil {
		return failed("SERVICE_REQUEST_CANCELLED")
	}
	target, err := open(request.Name)
	if err != nil || target == nil {
		return failed("SERVICE_TARGET_UNAVAILABLE")
	}
	defer target.Close()
	verify := func() bool {
		current, err := target.Fingerprint()
		return err == nil && current == request.DefinitionHash
	}
	if !verify() {
		return failed("SERVICE_TARGET_CHANGED")
	}
	if ctx.Err() != nil {
		return failed("SERVICE_REQUEST_CANCELLED")
	}
	switch request.Action {
	case "start-service":
		if target.Start(ctx) != nil {
			return unknown("SERVICE_START_OUTCOME_UNKNOWN")
		}
	case "stop-service":
		if target.Stop(ctx) != nil {
			return unknown("SERVICE_STOP_OUTCOME_UNKNOWN")
		}
	case "restart-service":
		if target.Stop(ctx) != nil {
			return unknown("SERVICE_STOP_OUTCOME_UNKNOWN")
		}
		if ctx.Err() != nil || !verify() {
			return unknown("SERVICE_RESTART_INCOMPLETE")
		}
		if target.Start(ctx) != nil {
			return unknown("SERVICE_RESTART_OUTCOME_UNKNOWN")
		}
	}
	return serviceControlOutcome{Status: statusSucceeded, Code: "SERVICE_CONTROL_SUCCEEDED"}
}

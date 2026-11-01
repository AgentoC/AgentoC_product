package main

import (
	"errors"
	"fmt"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func TestBrokerStatePathFailuresIdentifyAclBoundary(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want uint32
	}{
		{name: "ancestor", err: errors.New("APB_STATE_ANCESTOR_WRITABLE"), want: brokerExitStateAncestorACL},
		{name: "broker root", err: errors.New("APB_STATE_DACL_REFUSED"), want: brokerExitStateRootACL},
		{name: "state file", err: errors.New("APB_STATE_FILE_ACCESS_INCOMPLETE"), want: brokerExitStateFileACL},
		{name: "other", err: errors.New("APB_PROGRAMDATA_UNAVAILABLE"), want: brokerExitStateRootACL},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := brokerStatePathFailureCode(test.err); got != test.want {
				t.Fatalf("failure code: got %d, want %d", got, test.want)
			}
		})
	}
}

func TestBrokerIPCRuntimeFailureCodeIsRedacted(t *testing.T) {
	if got := brokerIPCRuntimeFailureCode(nil); got != "UNEXPECTED_CLEAN_EXIT" {
		t.Fatalf("clean exit code: %s", got)
	}
	if got := brokerIPCRuntimeFailureCode(fmt.Errorf("private pipe path: %w", windows.ERROR_ACCESS_DENIED)); got != "WIN32_5" {
		t.Fatalf("Windows failure code: %s", got)
	}
	if got := brokerIPCRuntimeFailureCode(errors.New("private path and token")); got != "OTHER" {
		t.Fatalf("other failure code: %s", got)
	}
}

func TestRefusesUnexpectedServiceIdentity(t *testing.T) {
	status := make(chan svc.Status, 2)
	_, code := (brokerService{}).Execute([]string{"AnotherService"}, nil, status)
	if code != 87 {
		t.Fatalf("unexpected SCM argument exit code: %d", code)
	}
	if first := <-status; first.State != svc.StartPending {
		t.Fatalf("unexpected first state: %v", first.State)
	}
	select {
	case next := <-status:
		t.Fatalf("untrusted service identity reached state: %v", next.State)
	default:
	}
}

func TestOrdinaryTokenNeverReachesRunning(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if user.User.Sid.String() == "S-1-5-18" {
		t.Skip("requires an ordinary, non-SYSTEM test process")
	}
	status := make(chan svc.Status, 2)
	specific, code := (brokerService{}).Execute([]string{serviceName}, nil, status)
	if !specific || code != brokerExitIdentityRefused {
		t.Fatalf("ordinary token exit code: %d", code)
	}
	<-status
	select {
	case next := <-status:
		t.Fatalf("ordinary token reached state: %v", next.State)
	default:
	}
}

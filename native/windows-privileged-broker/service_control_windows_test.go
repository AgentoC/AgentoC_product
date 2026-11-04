//go:build windows

package main

import (
	"context"
	"regexp"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestWindowsServiceControlRejectsInvalidAndCancelledRequests(t *testing.T) {
	if _, err := openWindowsServiceControl("valid", "delete"); err == nil {
		t.Fatal("unknown operation was accepted")
	}
	if _, err := openWindowsServiceControl("bad*", "start-service"); err == nil {
		t.Fatal("invalid name was accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	target := &windowsServiceControlTarget{}
	if target.Start(ctx) == nil || target.Stop(ctx) == nil {
		t.Fatal("cancelled operation was accepted")
	}
}

// Uses whichever existing service this user can inspect. It does not start,
// stop, install, or configure any service and is not tied to a specific host.
func TestWindowsServiceControlReadOnlyFingerprint(t *testing.T) {
	handle, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT|windows.SC_MANAGER_ENUMERATE_SERVICE)
	if err != nil {
		t.Skipf("SCM unavailable: %v", err)
	}
	manager := &mgr.Mgr{Handle: handle}
	defer manager.Disconnect()
	names, err := manager.ListServices()
	if err != nil {
		t.Skipf("service enumeration unavailable: %v", err)
	}
	for _, name := range names {
		first, err := inspectWindowsServiceControl(name)
		if err != nil {
			continue
		}
		second, err := inspectWindowsServiceControl(name)
		if err != nil {
			t.Fatalf("second inspection failed: %v", err)
		}
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(first) || first != second {
			t.Fatal("service fingerprint was invalid or unstable")
		}
		return
	}
	t.Skip("no service permits read-only configuration and security inspection")
}

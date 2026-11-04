//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestWindowsServiceImageSnapshotDetectsContentAndIdentityChanges(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.exe")
	second := filepath.Join(dir, "second.exe")
	if err := os.WriteFile(first, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	a, err := snapshotWindowsServiceImage(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := snapshotWindowsServiceImage(second)
	if err != nil {
		t.Fatal(err)
	}
	if a.Digest != b.Digest || (a.Volume == b.Volume && a.FileIndex == b.FileIndex) {
		t.Fatal("image identity was not independently recorded")
	}
	if err := os.WriteFile(first, []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := snapshotWindowsServiceImage(first)
	if err != nil {
		t.Fatal(err)
	}
	if a.Digest == c.Digest || a.FileIndex != c.FileIndex || a.Volume != c.Volume {
		t.Fatal("image content change was not detected")
	}
	if err := os.Link(first, filepath.Join(dir, "alias.exe")); err == nil {
		if _, err := snapshotWindowsServiceImage(first); err == nil {
			t.Fatal("hard-linked image accepted")
		}
	}
	if _, err := snapshotWindowsServiceImage("relative.exe"); err == nil {
		t.Fatal("relative image accepted")
	}
}

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

func TestWindowsSharedServiceReadOnlyFingerprint(t *testing.T) {
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
		ptr, err := windows.UTF16PtrFromString(name)
		if err != nil {
			continue
		}
		service, err := windows.OpenService(handle, ptr, windows.SERVICE_QUERY_CONFIG)
		if err != nil {
			continue
		}
		config, err := (&mgr.Service{Name: name, Handle: service}).Config()
		windows.CloseServiceHandle(service)
		if err != nil || config.ServiceType&windows.SERVICE_WIN32_SHARE_PROCESS == 0 {
			continue
		}
		first, err := inspectWindowsServiceControl(name)
		if err != nil {
			continue
		}
		second, err := inspectWindowsServiceControl(name)
		if err != nil {
			t.Fatal(err)
		}
		if first != second || !serviceDefinitionHash.MatchString(first) {
			t.Fatal("shared service fingerprint is unstable")
		}
		return
	}
	t.Skip("no shared service permits complete read-only inspection")
}

//go:build windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Opt-in acceptance touches only a fresh randomly named, inert test service.
// Its executable and all build/cache artifacts remain inside the owner workspace.
func TestWindowsServiceControlIsolatedLiveSCM(t *testing.T) {
	if os.Getenv("AGENTOC_BROKER_RUN_ISOLATED_SERVICE_TEST") != "1" {
		t.Skip("isolated live SCM test is opt-in")
	}
	if !strings.HasPrefix(strings.ToLower(filepath.Clean(os.TempDir()))+`\`, `g:\agentoc\`) {
		t.Fatal("test temporary directory must be under G:\\AgentoC")
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	if elevated, err := windows.GetCurrentProcessToken().IsMember(admins); err != nil || !elevated {
		t.Fatalf("isolated SCM test requires an administrator: %v", err)
	}
	random, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	name := "AgentoC-QA-Service-" + random
	binary := filepath.Join(t.TempDir(), "inert-service.exe")
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-o", binary, "./targetfixture")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v\n%s", err, output)
	}
	fixtureDir := filepath.Dir(binary)
	setLocalTargetOwner(t, fixtureDir, true)
	icacls := filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe")
	protect := exec.Command(icacls, fixtureDir, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F")
	if output, err := protect.CombinedOutput(); err != nil {
		t.Fatalf("protect fixture directory: %v\n%s", err, output)
	}
	manager, err := mgr.Connect()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Disconnect() })
	if existing, err := manager.OpenService(name); err == nil {
		existing.Close()
		t.Fatal("refusing to replace an existing service")
	} else if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		t.Fatal(err)
	}
	service, err := manager.CreateService(name, binary, mgr.Config{
		ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, StartType: windows.SERVICE_DEMAND_START,
		ErrorControl: windows.SERVICE_ERROR_IGNORE, DisplayName: "AgentoC isolated service test",
	}, "--service-name", name)
	if err != nil {
		t.Fatal(err)
	}
	var lastPID uint32
	t.Cleanup(func() {
		if status, err := service.Query(); err == nil && status.State != svc.Stopped {
			_, _ = service.Control(svc.Stop)
			if err := waitForFixtureServiceState(service, svc.Stopped); err != nil {
				t.Errorf("stop fixture: %v", err)
			}
		}
		if lastPID != 0 {
			if err := waitForFixtureProcessExit(lastPID, 10*time.Second); err != nil {
				t.Errorf("wait for fixture exit: %v", err)
			}
		}
		if err := service.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			t.Errorf("delete fixture: %v", err)
		}
		if err := service.Close(); err != nil {
			t.Errorf("close fixture: %v", err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			current, err := manager.OpenService(name)
			if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
				return
			}
			if err != nil {
				t.Errorf("check fixture cleanup: %v", err)
				return
			}
			_ = current.Close()
			time.Sleep(100 * time.Millisecond)
		}
		t.Error("fixture service was not removed")
	})
	hash, err := inspectWindowsServiceControl(name)
	if err != nil {
		t.Fatalf("inspect fixture: %v", err)
	}
	allowUserWrite := exec.Command(icacls, fixtureDir, "/grant:r", "*S-1-5-32-545:(OI)(CI)M")
	if output, err := allowUserWrite.CombinedOutput(); err != nil {
		t.Fatalf("create writable fixture: %v\n%s", err, output)
	}
	if target, err := openWindowsServiceControl(name, "start-service"); err == nil {
		_ = target.Close()
		t.Fatal("service with a user-writable image directory was accepted")
	}
	removeUserWrite := exec.Command(icacls, fixtureDir, "/remove:g", "*S-1-5-32-545")
	if output, err := removeUserWrite.CombinedOutput(); err != nil {
		t.Fatalf("restore fixture protection: %v\n%s", err, output)
	}
	run := func(action string, expected svc.State) {
		t.Helper()
		request := serviceControlRequest{Name: name, Action: action, DefinitionHash: hash}
		outcome := runServiceControl(context.Background(), request, func(target string) (serviceControlTarget, error) {
			return openWindowsServiceControl(target, action)
		})
		if outcome.Status != statusSucceeded {
			t.Fatalf("%s: %+v", action, outcome)
		}
		status, err := service.Query()
		if err != nil || status.State != expected {
			t.Fatalf("%s state: %+v %v", action, status, err)
		}
		if status.ProcessId != 0 {
			lastPID = status.ProcessId
		}
	}
	run("start-service", svc.Running)
	run("restart-service", svc.Running)
	run("stop-service", svc.Stopped)
	refused := runServiceControl(context.Background(), serviceControlRequest{Name: name, Action: "start-service", DefinitionHash: strings.Repeat("0", 64)},
		func(target string) (serviceControlTarget, error) {
			return openWindowsServiceControl(target, "start-service")
		})
	if refused.Status != statusFailed || refused.Code != "SERVICE_TARGET_CHANGED" {
		t.Fatalf("changed target accepted: %+v", refused)
	}

	// Exercise signed proposal and enrolled-device approval through the broker
	// handler and real SCM backend. The elevated process cannot use the
	// ordinary-user pipe; its peer checks are covered by separate pipe tests.
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := store.ConfigureAutoInstallSigner("test-key", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	deviceKey, deviceID := enrollServiceTestDevice(t, store, now)
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	base := `\\.\pipe\AgentoC.PrivilegedBroker.LocalTest.` + random
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, base+".Health", base+".Request")
	if err != nil {
		t.Fatal(err)
	}
	server.serviceController = func(ctx context.Context, request serviceControlRequest) serviceControlOutcome {
		return runServiceControl(ctx, request, func(target string) (serviceControlTarget, error) {
			return openWindowsServiceControl(target, request.Action)
		})
	}
	done := make(chan error, 1)
	go func() { done <- server.Run(context.Background()) }()
	t.Cleanup(func() {
		server.Stop()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("stop test broker: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("test broker did not stop")
		}
	})
	snapshot := store.Snapshot()
	grant := serviceControlGrant{Version: 1, KeyID: "test-key", BrokerInstallationID: snapshot.InstallationID,
		PolicyGeneration: snapshot.PolicyGeneration, RequestID: "live-request", SessionID: "session", RunID: "run", TurnID: "turn",
		ActionID: "action", Nonce: "abcdefghijklmnopqrstuvwxyz012345", ServiceName: name, Action: "start-service",
		DefinitionHash: hash, Authorization: "owner", IssuedMS: uint64(now.UnixMilli()), ExpiresMS: uint64(now.Add(time.Minute).UnixMilli())}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(grant)))
	proposal := brokerRequest{Version: protocolVersion, Type: "service.propose", ServiceControl: &grant, Signature: signature}
	if result := server.handleRequest(mustJSON(t, proposal), false); result.Status != statusAwaitingDevice {
		t.Fatalf("live proposal failed: %+v", result)
	}
	approval := brokerRequest{Version: protocolVersion, Type: "service.approve", RequestID: grant.RequestID, DeviceID: deviceID,
		DeviceSignature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(grant))}
	if result := server.handleRequest(mustJSON(t, approval), false); result.Status != statusExecuting && result.Status != statusSucceeded {
		t.Fatalf("live approval failed: %+v", result)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		result := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID}), false)
		if result.Status == statusSucceeded {
			break
		}
		if result.Status != statusExecuting || time.Now().After(deadline) {
			t.Fatalf("live service result: %+v", result)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if status, err := service.Query(); err != nil || status.State != svc.Running {
		t.Fatalf("approved service did not start: %+v %v", status, err)
	} else {
		lastPID = status.ProcessId
	}
	if result := server.handleRequest(mustJSON(t, approval), false); result.Status != statusSucceeded {
		t.Fatalf("approval replay changed outcome: %+v", result)
	}
}

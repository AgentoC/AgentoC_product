//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

// This backend is not exposed by the broker request protocol. Before wiring
// it to authorized requests, the caller must pin and verify the service image
// and any service DLL, and bind their identities into the approval snapshot.
type windowsServiceControlTarget struct {
	name   string
	handle windows.Handle
}

func openWindowsServiceControl(name, action string) (serviceControlTarget, error) {
	if !validServiceControlName(name) {
		return nil, errors.New("invalid service name")
	}
	access := uint32(windows.SERVICE_QUERY_CONFIG | windows.SERVICE_QUERY_STATUS | windows.READ_CONTROL)
	switch action {
	case "start-service":
		access |= windows.SERVICE_START
	case "stop-service":
		access |= windows.SERVICE_STOP
	case "restart-service":
		access |= windows.SERVICE_START | windows.SERVICE_STOP
	default:
		return nil, errors.New("invalid service action")
	}
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, err
	}
	defer windows.CloseServiceHandle(manager)
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, err := windows.OpenService(manager, namePtr, access)
	if err != nil {
		return nil, err
	}
	return &windowsServiceControlTarget{name: name, handle: handle}, nil
}

func (s *windowsServiceControlTarget) Fingerprint() (string, error) {
	return fingerprintWindowsServiceControlHandle(s.name, s.handle)
}
func (s *windowsServiceControlTarget) Close() error { return windows.CloseServiceHandle(s.handle) }

func waitWindowsServiceControlState(ctx context.Context, handle windows.Handle, wanted uint32, timeout time.Duration) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		status, err := queryBrokerTargetStatus(handle)
		if err != nil {
			return err
		}
		if status.CurrentState == wanted {
			return nil
		}
		if !brokerTargetTransitionPending(status.CurrentState, wanted) {
			return errors.New("unexpected service state")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errors.New("service transition timed out")
		case <-ticker.C:
		}
	}
}

func (s *windowsServiceControlTarget) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	status, err := queryBrokerTargetStatus(s.handle)
	if err != nil {
		return err
	}
	if status.CurrentState == windows.SERVICE_RUNNING {
		return nil
	}
	if status.CurrentState != windows.SERVICE_STOPPED {
		return errors.New("service is not stopped")
	}
	if err := windows.StartService(s.handle, 0, nil); err != nil {
		return err
	}
	return waitWindowsServiceControlState(ctx, s.handle, windows.SERVICE_RUNNING, targetStartTimeout)
}

func (s *windowsServiceControlTarget) Stop(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	status, err := queryBrokerTargetStatus(s.handle)
	if err != nil {
		return err
	}
	if status.CurrentState == windows.SERVICE_STOPPED {
		return nil
	}
	if status.CurrentState != windows.SERVICE_RUNNING {
		return errors.New("service is not running")
	}
	if err := windows.ControlService(s.handle, windows.SERVICE_CONTROL_STOP, new(windows.SERVICE_STATUS)); err != nil {
		return err
	}
	return waitWindowsServiceControlState(ctx, s.handle, windows.SERVICE_STOPPED, targetStopTimeout)
}

// This is read-only inspection. The SCM handle, not a provider-supplied
// executable or path, supplies the service configuration and security data.
// The returned digest is not yet an execution authorization: the approval
// transport and the final mutating backend must both bind this exact digest.
func inspectWindowsServiceControl(name string) (string, error) {
	if !validServiceControlName(name) {
		return "", errors.New("invalid service name")
	}
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return "", err
	}
	defer windows.CloseServiceHandle(manager)
	serviceName, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return "", err
	}
	service, err := windows.OpenService(manager, serviceName, windows.SERVICE_QUERY_CONFIG|windows.READ_CONTROL)
	if err != nil {
		return "", err
	}
	defer windows.CloseServiceHandle(service)
	return fingerprintWindowsServiceControlHandle(name, service)
}

func fingerprintWindowsServiceControlHandle(name string, handle windows.Handle) (string, error) {
	if !validServiceControlName(name) || handle == 0 {
		return "", errors.New("invalid service target")
	}
	config, err := (&mgr.Service{Name: name, Handle: handle}).Config()
	if err != nil {
		return "", err
	}
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_SERVICE,
		windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION)
	if err != nil || descriptor == nil {
		return "", errors.New("service security descriptor unavailable")
	}
	raw, err := json.Marshal(struct {
		Name     string     `json:"name"`
		Config   mgr.Config `json:"config"`
		Security string     `json:"security"`
	}{
		Name: name, Config: config, Security: descriptor.String(),
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

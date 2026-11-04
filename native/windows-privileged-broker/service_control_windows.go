//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

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

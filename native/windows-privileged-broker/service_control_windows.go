//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc/mgr"
)

// This backend is not exposed by the broker request protocol. Before wiring
// it to authorized requests, the caller must pin and verify the service image
// and any service DLL, and bind their identities into the approval snapshot.
type windowsServiceControlTarget struct {
	name      string
	handle    windows.Handle
	imagePins []*serviceImagePins
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
	if err := validateServiceControlHandleSecurity(handle); err != nil {
		windows.CloseServiceHandle(handle)
		return nil, err
	}
	config, err := (&mgr.Service{Name: name, Handle: handle}).Config()
	if err != nil {
		windows.CloseServiceHandle(handle)
		return nil, err
	}
	if config.ServiceType&windows.SERVICE_WIN32_SHARE_PROCESS != 0 {
		if err := validateSharedServiceRegistrySecurity(name); err != nil {
			windows.CloseServiceHandle(handle)
			return nil, err
		}
	}
	pins, err := pinWindowsServiceImages(name, config)
	if err != nil {
		windows.CloseServiceHandle(handle)
		return nil, err
	}
	if err := validatePinnedServiceImageDirectories(pins); err != nil {
		for _, pin := range pins {
			pin.Close()
		}
		windows.CloseServiceHandle(handle)
		return nil, err
	}
	return &windowsServiceControlTarget{name: name, handle: handle, imagePins: pins}, nil
}

func (s *windowsServiceControlTarget) Fingerprint() (string, error) {
	if err := validatePinnedServiceImageDirectories(s.imagePins); err != nil {
		return "", err
	}
	if err := validateServiceControlHandleSecurity(s.handle); err != nil {
		return "", err
	}
	config, err := (&mgr.Service{Name: s.name, Handle: s.handle}).Config()
	if err != nil {
		return "", err
	}
	if config.ServiceType&windows.SERVICE_WIN32_SHARE_PROCESS != 0 {
		if err := validateSharedServiceRegistrySecurity(s.name); err != nil {
			return "", err
		}
	}
	images, _, err := snapshotWindowsServiceImages(s.name, config)
	if err != nil || len(images) != len(s.imagePins) {
		return "", errors.New("service images changed")
	}
	for i, image := range images {
		if s.imagePins[i] == nil || !reflect.DeepEqual(image, s.imagePins[i].snapshot) {
			return "", errors.New("service images changed")
		}
	}
	return fingerprintWindowsServiceControlHandle(s.name, s.handle)
}
func (s *windowsServiceControlTarget) Close() error {
	for i := len(s.imagePins) - 1; i >= 0; i-- {
		s.imagePins[i].Close()
	}
	s.imagePins = nil
	return windows.CloseServiceHandle(s.handle)
}

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
	images, registrySecurity, err := snapshotWindowsServiceImages(name, config)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(struct {
		Name             string                 `json:"name"`
		Config           mgr.Config             `json:"config"`
		Security         string                 `json:"security"`
		Images           []serviceImageSnapshot `json:"images"`
		RegistrySecurity string                 `json:"registrySecurity"`
	}{
		Name: name, Config: config, Security: descriptor.String(), Images: images, RegistrySecurity: registrySecurity,
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

type serviceImageSnapshot struct {
	Path      string `json:"path"`
	Digest    string `json:"digest"`
	Security  string `json:"security"`
	Volume    uint32 `json:"volume"`
	FileIndex uint64 `json:"fileIndex"`
}

// Read through a single file handle and reject reparse points. Hard links are
// normal for Windows system files; execution pins the underlying file without
// write or delete sharing, so another link cannot modify the pinned image.
func snapshotWindowsServiceImage(raw string) (serviceImageSnapshot, error) {
	var result serviceImageSnapshot
	expanded, err := registry.ExpandString(raw)
	if err != nil {
		return result, err
	}
	path := filepath.Clean(expanded)
	if !filepath.IsAbs(path) || len(filepath.VolumeName(path)) != 2 || strings.Contains(path, "%") {
		return result, errors.New("service image path is not an absolute local path")
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return result, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return result, err
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		windows.CloseHandle(handle)
		return result, errors.New("service image handle unavailable")
	}
	defer file.Close()
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
		return result, errors.New("service image identity is unsafe")
	}
	buffer := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || n == 0 || n >= uint32(len(buffer)) || !strings.EqualFold(windows.UTF16ToString(buffer[:n]), `\\?\`+path) {
		return result, errors.New("service image path changed")
	}
	size := int64(info.FileSizeHigh)<<32 | int64(info.FileSizeLow)
	if size <= 0 || size > targetBinaryMaxBytes {
		return result, errors.New("service image size is invalid")
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || sd == nil {
		return result, errors.New("service image security unavailable")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return result, err
	}
	return serviceImageSnapshot{Path: path, Digest: hex.EncodeToString(hash.Sum(nil)), Security: sd.String(), Volume: info.VolumeSerialNumber,
		FileIndex: uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow)}, nil
}

func snapshotWindowsServiceImages(name string, config mgr.Config) ([]serviceImageSnapshot, string, error) {
	arguments, err := windows.DecomposeCommandLine(config.BinaryPathName)
	if err != nil || len(arguments) == 0 {
		return nil, "", errors.New("service image command is invalid")
	}
	image, err := snapshotWindowsServiceImage(arguments[0])
	if err != nil {
		return nil, "", err
	}
	images := []serviceImageSnapshot{image}
	dependencies, err := serviceCommandFileDependencies(arguments)
	if err != nil {
		return nil, "", err
	}
	for _, dependency := range dependencies {
		file, err := snapshotWindowsServiceImage(dependency)
		if err != nil {
			return nil, "", err
		}
		images = append(images, file)
	}
	if config.ServiceType&windows.SERVICE_WIN32_SHARE_PROCESS != 0 {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\`+name+`\Parameters`, registry.QUERY_VALUE|windows.READ_CONTROL)
		if err != nil {
			return nil, "", err
		}
		defer key.Close()
		sd, err := windows.GetSecurityInfo(windows.Handle(key), windows.SE_REGISTRY_KEY, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil || sd == nil {
			return nil, "", errors.New("shared service registry security unavailable")
		}
		dll, valueType, err := key.GetStringValue("ServiceDll")
		if err != nil || (valueType != registry.SZ && valueType != registry.EXPAND_SZ) {
			return nil, "", errors.New("shared service DLL unavailable")
		}
		shared, err := snapshotWindowsServiceImage(dll)
		if err != nil {
			return nil, "", err
		}
		images = append(images, shared)
		return images, sd.String(), nil
	}
	return images, "", nil
}

// PowerShell can execute code from a file independent of its executable. Bind
// that file too. Inline and encoded commands have no separately pinnable
// target; they require a different execution boundary.
func serviceCommandFileDependencies(arguments []string) ([]string, error) {
	if len(arguments) == 0 {
		return nil, errors.New("service image command is invalid")
	}
	switch strings.ToLower(filepath.Base(arguments[0])) {
	case "powershell.exe", "pwsh.exe":
		for i := 1; i < len(arguments); i++ {
			option := strings.ToLower(arguments[i])
			switch option {
			case "-nologo", "-noprofile", "-noninteractive":
			case "-executionpolicy", "-windowstyle":
				i++
				if i >= len(arguments) || arguments[i] == "" || strings.HasPrefix(arguments[i], "-") {
					return nil, errors.New("service host option is invalid")
				}
			case "-file":
				i++
				if i >= len(arguments) {
					return nil, errors.New("service script is missing")
				}
				expanded, err := registry.ExpandString(arguments[i])
				if err != nil || !filepath.IsAbs(expanded) || !strings.EqualFold(filepath.Ext(expanded), ".ps1") {
					return nil, errors.New("service script must be an absolute PowerShell file")
				}
				return []string{arguments[i]}, nil
			default:
				return nil, errors.New("service host command is not a verifiable PowerShell file")
			}
		}
		return nil, errors.New("service host command has no verifiable PowerShell file")
	default:
		return nil, nil
	}
}

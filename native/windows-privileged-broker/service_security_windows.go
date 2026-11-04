//go:build windows

package main

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var errServiceDefinitionUnprotected = errors.New("service definition can be changed by an untrusted principal")

// Control rights alone are not definition-mutation rights. Permit a service
// to grant ordinary users start/stop while requiring its configuration, owner,
// DACL and deletion rights to remain administrator-controlled.
func validateServiceDefinitionSecurity(sd *windows.SECURITY_DESCRIPTOR, mutationMask uint32) error {
	if sd == nil {
		return errServiceDefinitionUnprotected
	}
	owner, _, err := sd.Owner()
	if err != nil || !ownerPolicyAdmin(owner) {
		return errServiceDefinitionUnprotected
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errServiceDefinitionUnprotected
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil || ace == nil {
			return errServiceDefinitionUnprotected
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errServiceDefinitionUnprotected
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !ownerPolicyAdmin(sid) && uint32(ace.Mask)&mutationMask != 0 {
			return errServiceDefinitionUnprotected
		}
	}
	return nil
}

func validateServiceControlHandleSecurity(handle windows.Handle) error {
	sd, err := windows.GetSecurityInfo(handle, windows.SE_SERVICE, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return errServiceDefinitionUnprotected
	}
	mask := uint32(windows.SERVICE_CHANGE_CONFIG | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL)
	return validateServiceDefinitionSecurity(sd, mask)
}

// The image itself is held without write sharing. Its containing directory
// must also prevent an untrusted principal from planting sibling DLLs or
// replacing configuration files loaded by the elevated service.
func validateServiceImageDirectorySecurity(sd *windows.SECURITY_DESCRIPTOR) error {
	const addFile = 0x0002
	const addDirectory = 0x0004
	const deleteChild = 0x0040
	const writeEA = 0x0010
	const writeAttributes = 0x0100
	mask := uint32(addFile | addDirectory | deleteChild | writeEA | writeAttributes |
		windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL)
	return validateServiceDefinitionSecurity(sd, mask)
}

func validatePinnedServiceImageDirectories(pins []*serviceImagePins) error {
	for _, pin := range pins {
		if pin == nil || len(pin.handles) < 2 {
			return errServiceDefinitionUnprotected
		}
		parent := pin.handles[len(pin.handles)-2]
		sd, err := windows.GetSecurityInfo(parent, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil || validateServiceImageDirectorySecurity(sd) != nil {
			return errServiceDefinitionUnprotected
		}
	}
	return nil
}

// Check each registry ancestor as well as Parameters. A writable parent or
// key could otherwise be replaced after the approved ServiceDll was checked.
func validateSharedServiceRegistrySecurity(name string) error {
	if !validServiceControlName(name) {
		return errServiceDefinitionUnprotected
	}
	paths := []string{`SYSTEM`, `SYSTEM\CurrentControlSet`, `SYSTEM\CurrentControlSet\Services`,
		`SYSTEM\CurrentControlSet\Services\` + name, `SYSTEM\CurrentControlSet\Services\` + name + `\Parameters`}
	mask := uint32(registry.SET_VALUE | registry.CREATE_SUB_KEY | registry.CREATE_LINK | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL)
	for _, path := range paths {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, windows.READ_CONTROL)
		if err != nil {
			return errServiceDefinitionUnprotected
		}
		sd, err := windows.GetSecurityInfo(windows.Handle(key), windows.SE_REGISTRY_KEY, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		_ = key.Close()
		if err != nil || validateServiceDefinitionSecurity(sd, mask) != nil {
			return errServiceDefinitionUnprotected
		}
	}
	return nil
}

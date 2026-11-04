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

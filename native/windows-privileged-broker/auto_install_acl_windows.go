//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

const runtimeDirectoryMutationRights = windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER |
	windows.GENERIC_WRITE | windows.GENERIC_ALL |
	0x00000002 | // FILE_ADD_FILE
	0x00000004 | // FILE_ADD_SUBDIRECTORY
	0x00000010 | // FILE_WRITE_EA
	0x00000040 | // FILE_DELETE_CHILD
	0x00000100 // FILE_WRITE_ATTRIBUTES

func runtimeDirectoryACECanMutate(sid *windows.SID, mask uint32, flags uint8) bool {
	if sid == nil || flags&windows.INHERIT_ONLY_ACE != 0 || isRuntimeAdministrator(sid) {
		return false
	}
	return mask&runtimeDirectoryMutationRights != 0
}

func isRuntimeAdministrator(sid *windows.SID) bool {
	if sid == nil {
		return false
	}
	return sid.String() == "S-1-5-18" || sid.String() == "S-1-5-32-544" || sid.String() == trustedInstallerSID
}

// File handles prevent replacement of existing components; this check also
// prevents untrusted principals adding a loadable file to a runtime directory.
func verifyRuntimeDirectoryACL(path string) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return errRuntimeIntegrity
	}
	owner, _, err := sd.Owner()
	if err != nil || !isRuntimeAdministrator(owner) {
		return errRuntimeIntegrity
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errRuntimeIntegrity
	}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace == nil {
			return errRuntimeIntegrity
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errRuntimeIntegrity
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if runtimeDirectoryACECanMutate(sid, uint32(ace.Mask), ace.Header.AceFlags) {
			return errRuntimeIntegrity
		}
	}
	return nil
}
